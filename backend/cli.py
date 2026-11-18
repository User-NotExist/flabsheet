"""Management CLI for the flabsheet backend.

Usage:
    uv run python cli.py seed-admin --login-id admin --display-name "Administrator"
    uv run python cli.py seed-students
    uv run python cli.py migrate-to-mongo
    uv run python cli.py migrate-to-mongo --drop-old      # then drop the old Postgres data

The admin password comes from ADMIN_PASSWORD or an interactive prompt. Without
--login-id / --display-name, an interactive run asks for them too.
Seeded students receive individual, generated first-login passwords.
migrate-to-mongo copies the operation log and the submission results left in
Postgres by older versions into MongoDB; it is safe to run more than once.
With --drop-old it then checks that every old row is in MongoDB and drops the
old tables and column (asks first, unless --yes).
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from argon2 import PasswordHasher
from psycopg.errors import UniqueViolation
from pymongo import UpdateOne
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from db.mongo import ensure_indexes, operation_logs, submission_reports
from db.postgres import Base, SessionLocal, engine
from db.models.user import User, UserRole
from services.operation_log import log_operation
from services.students import new_student

LOGIN_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
MIN_PASSWORD_LENGTH = 8
DEMO_STUDENTS = (
    ("6512345", "Ananya P.", True),
    ("6512346", "Kanya S.", True),
    ("6512347", "Mali T.", True),
    ("6512348", "Narin W.", True),
    ("6512349", "Pim K.", True),
    ("6512350", "Thanat R.", False),
    ("6512351", "Sirin C.", True),
)


def ensure_schema() -> None:
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS citext"))
    Base.metadata.create_all(engine)
    ensure_indexes()


def read_password() -> str:
    password = os.environ.get("ADMIN_PASSWORD")
    if password is not None:
        return password

    if not sys.stdin.isatty():
        sys.exit("error: set ADMIN_PASSWORD or run interactively to enter a password")

    password = getpass.getpass("Admin password: ")
    if password != getpass.getpass("Confirm password: "):
        sys.exit("error: passwords do not match")
    return password


def ask(prompt: str, value: str | None, default: str) -> str:
    """The flag value if given, else a prompt (interactive) or the default."""
    if value is not None:
        return value
    if not sys.stdin.isatty():
        return default
    return input(f"{prompt} [{default}]: ").strip() or default


def seed_admin(args: argparse.Namespace) -> None:
    args.login_id = ask("Login ID", args.login_id, "admin")
    args.display_name = ask("Display name", args.display_name, "Administrator")
    if not LOGIN_ID_RE.fullmatch(args.login_id):
        sys.exit("error: login id must be 1-64 chars of A-Z a-z 0-9 . _ -")
    if not 1 <= len(args.display_name) <= 100:
        sys.exit("error: display name must be 1-100 characters")

    ensure_schema()

    with SessionLocal() as db:
        # login_id is CITEXT, so this comparison is case-insensitive
        existing = db.scalar(select(User).where(User.login_id == args.login_id))
        if existing is not None and not args.reset_password:
            print(f"User '{existing.login_id}' already exists (role={existing.role.value}); nothing to do.")
            print("Pass --reset-password to overwrite its password and promote it to admin.")
            return

        password = read_password()
        if len(password) < MIN_PASSWORD_LENGTH:
            sys.exit(f"error: password must be at least {MIN_PASSWORD_LENGTH} characters")
        password_hash = PasswordHasher().hash(password)

        if existing is not None:
            existing.password_hash = password_hash
            existing.role = UserRole.admin
            existing.is_active = True
            existing.must_change_password = args.must_change_password
            db.commit()
            print(f"Updated user '{existing.login_id}' (id={existing.id}) as admin.")
            return

        admin = User(
            login_id=args.login_id,
            display_name=args.display_name,
            role=UserRole.admin,
            password_hash=password_hash,
            must_change_password=args.must_change_password,
        )
        db.add(admin)
        db.commit()
        print(f"Created admin '{admin.login_id}' (id={admin.id}).")


def seed_students(_args: argparse.Namespace) -> None:
    """Insert missing demo students and reveal credentials only after commit."""
    ensure_schema()
    created: list[tuple[str, str]] = []
    with SessionLocal.begin() as db:
        for login_id, display_name, is_active in DEMO_STUDENTS:
            existing = select(User.id).where(User.login_id == login_id)
            if db.scalar(existing) is not None:
                continue
            student, password = new_student(login_id, display_name, None, is_active=is_active)
            try:
                # Another creator may claim this login ID after the initial check.
                with db.begin_nested():
                    db.add(student)
                    db.flush()
            except IntegrityError as exc:
                if not isinstance(exc.orig, UniqueViolation) or db.scalar(existing) is None:
                    raise
                continue
            created.append((login_id, password))
        if created:
            log_operation(db, "student.seed", info={"login_ids": [row[0] for row in created]})

    print(f"Created {len(created)} demo students. Skipped {len(DEMO_STUDENTS) - len(created)} existing IDs.")
    if created:
        print("Initial passwords (shown once):")
        for login_id, password in created:
            print(f"{login_id}: {password}")


MIGRATE_BATCH = 1000  # documents per bulk_write


def _table_exists(conn: Any, name: str) -> bool:
    return conn.scalar(text("SELECT to_regclass(:name) IS NOT NULL"), {"name": name})


def _column_exists(conn: Any, table: str, column: str) -> bool:
    return conn.scalar(
        text(
            "SELECT EXISTS (SELECT 1 FROM information_schema.columns"
            " WHERE table_schema = current_schema() AND table_name = :t AND column_name = :c)"
        ),
        {"t": table, "c": column},
    )


def _flush(collection: Any, ops: list[UpdateOne]) -> int:
    if not ops:
        return 0
    collection.bulk_write(ops, ordered=True)
    count = len(ops)
    ops.clear()
    return count


def _legacy_info(info: str | None) -> Any:
    # The column held json.dumps(dict) or a plain string; only an object is
    # turned back into a document, so a string such as "42" stays a string.
    if info is None:
        return None
    try:
        parsed = json.loads(info)
    except ValueError:
        return info
    return parsed if isinstance(parsed, dict) else info


def _migrate_logs(conn: Any) -> int:
    collection = operation_logs()
    ops: list[UpdateOne] = []
    copied = 0
    # Upsert on legacy_id with $setOnInsert: a second run changes nothing.
    # Ordered by id, so the new _ids keep the old order for equal times.
    rows = conn.execute(
        text("SELECT id, created_at, user_id, type, info FROM operation_logs ORDER BY id")
    )
    for row in rows:
        ops.append(
            UpdateOne(
                {"legacy_id": row.id},
                {
                    "$setOnInsert": {
                        "legacy_id": row.id,
                        "created_at": row.created_at,
                        "type": row.type,
                        "user_id": row.user_id,
                        "info": _legacy_info(row.info),
                    }
                },
                upsert=True,
            )
        )
        if len(ops) >= MIGRATE_BATCH:
            copied += _flush(collection, ops)
    return copied + _flush(collection, ops)


def _migrate_reports(conn: Any) -> int:
    has_results = _table_exists(conn, "submission_results")
    has_log = _column_exists(conn, "submissions", "compile_log")
    # (submission_id, attempt) -> fields to $set
    fields: dict[tuple[int, int], dict[str, Any]] = defaultdict(dict)
    meta: dict[int, Any] = {}

    if has_results:
        rows = conn.execute(
            text(
                "SELECT r.submission_id, r.attempt, r.test_case_id, r.verdict, r.time_ms,"
                " r.memory_kb, r.fraction, r.checker_msg, r.output_preview, r.preview_truncated,"
                " s.problem_id, s.user_id"
                " FROM submission_results r JOIN submissions s ON s.id = r.submission_id"
            )
        )
        for row in rows:
            meta[row.submission_id] = row
            fields[(row.submission_id, row.attempt)][f"results.{row.test_case_id}"] = {
                "verdict": row.verdict,
                "time_ms": row.time_ms,
                "memory_kb": row.memory_kb,
                "fraction": float(row.fraction) if row.fraction is not None else None,
                "checker_msg": row.checker_msg,
                # Already only stored for sample and visible cases (NFR-SEC-07)
                "output_preview": row.output_preview,
                "preview_truncated": row.preview_truncated,
            }
    if has_log:
        rows = conn.execute(
            text(
                "SELECT id AS submission_id, attempt, problem_id, user_id, compile_log"
                " FROM submissions WHERE compile_log IS NOT NULL"
            )
        )
        for row in rows:
            meta.setdefault(row.submission_id, row)
            fields[(row.submission_id, row.attempt)]["compile_log"] = row.compile_log

    collection = submission_reports()
    ops: list[UpdateOne] = []
    copied = 0
    now = datetime.now(timezone.utc)
    for (submission_id, attempt), values in fields.items():
        row = meta[submission_id]
        # $set per result key merges with anything the live backend already
        # wrote for the same attempt instead of replacing the document.
        ops.append(
            UpdateOne(
                {"_id": f"{submission_id}:{attempt}"},
                {
                    "$set": {**values, "updated_at": now},
                    "$setOnInsert": {
                        "submission_id": submission_id,
                        "attempt": attempt,
                        "problem_id": row.problem_id,
                        "user_id": row.user_id,
                    },
                },
                upsert=True,
            )
        )
        if len(ops) >= MIGRATE_BATCH:
            copied += _flush(collection, ops)
    return copied + _flush(collection, ops)


# What older versions kept in Postgres. Dropped in this order by --drop-old.
OLD_TABLES = ("submission_results", "operation_logs")
OLD_COLUMN = ("submissions", "compile_log")
LOCK_TIMEOUT = "5s"  # fail instead of queueing behind the live app's transactions


def _old_data(conn: Any) -> tuple[bool, bool, bool]:
    return (
        _table_exists(conn, "operation_logs"),
        _table_exists(conn, "submission_results"),
        _column_exists(conn, *OLD_COLUMN),
    )


def _copy(conn: Any) -> None:
    has_logs, has_results, has_log = _old_data(conn)
    if has_logs:
        print(f"operation_logs: {_migrate_logs(conn)} rows copied or already present")
    else:
        print("operation_logs: no table, nothing to copy")
    if has_results or has_log:
        print(f"submission_reports: {_migrate_reports(conn)} attempts copied or merged")
    else:
        print("submission_reports: no submission_results table or compile_log column, nothing to copy")


def _chunks(values: list[Any]) -> Any:
    for start in range(0, len(values), MIGRATE_BATCH):
        yield values[start : start + MIGRATE_BATCH]


def _verify(conn: Any) -> list[str]:
    """What is in the old Postgres data but missing from MongoDB. Empty = safe to drop."""
    has_logs, has_results, has_log = _old_data(conn)
    missing: list[str] = []

    if has_logs:
        ids = list(conn.scalars(text("SELECT id FROM operation_logs")))
        found = sum(
            operation_logs().count_documents({"legacy_id": {"$in": chunk}}) for chunk in _chunks(ids)
        )
        if found != len(ids):
            missing.append(f"operation_logs: {len(ids) - found} of {len(ids)} rows not in MongoDB")

    # report _id -> result keys and whether a compile log is expected
    wanted: dict[str, tuple[set[str], bool]] = defaultdict(lambda: (set(), False))
    if has_results:
        for row in conn.execute(
            text("SELECT submission_id, attempt, test_case_id FROM submission_results")
        ):
            wanted[f"{row.submission_id}:{row.attempt}"][0].add(str(row.test_case_id))
    if has_log:
        for row in conn.execute(
            text("SELECT id, attempt FROM submissions WHERE compile_log IS NOT NULL")
        ):
            key = f"{row.id}:{row.attempt}"
            wanted[key] = (wanted[key][0], True)
    absent_results = absent_logs = 0
    for chunk in _chunks(list(wanted)):
        docs = {
            doc["_id"]: doc
            for doc in submission_reports().find(
                {"_id": {"$in": chunk}}, {"results": 1, "compile_log": 1}
            )
        }
        for key in chunk:
            cases, needs_log = wanted[key]
            doc = docs.get(key, {})
            absent_results += len(cases - set((doc.get("results") or {}).keys()))
            absent_logs += needs_log and doc.get("compile_log") is None
    if absent_results:
        missing.append(f"submission_results: {absent_results} results not in MongoDB")
    if absent_logs:
        missing.append(f"submissions.compile_log: {absent_logs} compile logs not in MongoDB")
    return missing


def _confirm(skip: bool) -> None:
    if skip:
        return
    if not sys.stdin.isatty():
        sys.exit("error: pass --yes to drop the old data without a prompt")
    answer = input("Drop the old Postgres tables and column now? This cannot be undone. Type 'drop': ")
    if answer.strip() != "drop":
        sys.exit("Nothing dropped.")


def migrate_to_mongo(args: argparse.Namespace) -> None:
    """Copy what older versions kept in Postgres into MongoDB, and with
    --drop-old remove it from Postgres once every row is verified there."""
    ensure_indexes()
    with engine.connect() as conn:
        _copy(conn)
        has_any = any(_old_data(conn))
        missing = _verify(conn) if has_any else []
    if missing:
        sys.exit("error: copy incomplete, nothing dropped:\n  " + "\n  ".join(missing))

    if not args.drop_old:
        if has_any:
            print()
            print("Verified: every old row is in MongoDB. Check /admin/logs and a few result")
            print("pages, then run again with --drop-old to remove the old Postgres data.")
        return
    if not has_any:
        print("No old Postgres data left; nothing to drop.")
        return

    _confirm(args.yes)
    # One transaction: lock the old data so nothing is added between the
    # final copy and the drop, copy again (idempotent) to pick up rows written
    # since the first pass, verify, then drop. Any failure rolls the drop back.
    with engine.begin() as conn:
        conn.execute(text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))
        has_logs, has_results, has_log = _old_data(conn)
        locked = [name for name, present in (
            ("submission_results", has_results),
            ("operation_logs", has_logs),
            ("submissions", has_log),
        ) if present]
        conn.execute(text(f"LOCK TABLE {', '.join(locked)} IN ACCESS EXCLUSIVE MODE"))
        print()
        print("Final pass under lock:")
        _copy(conn)
        missing = _verify(conn)
        if missing:
            # Raising inside engine.begin() rolls the transaction back
            raise SystemExit("error: copy incomplete, nothing dropped:\n  " + "\n  ".join(missing))
        for table in OLD_TABLES:
            conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
        conn.execute(text(f"ALTER TABLE {OLD_COLUMN[0]} DROP COLUMN IF EXISTS {OLD_COLUMN[1]}"))
    print("Dropped operation_logs, submission_results and submissions.compile_log.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cli.py", description="flabsheet backend management")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("seed-admin", help="create the initial admin user")
    # Left out: asked for interactively, else the default.
    p.add_argument("--login-id", help="login id (default: admin)")
    p.add_argument("--display-name", help="display name (default: Administrator)")
    p.add_argument(
        "--must-change-password",
        action="store_true",
        help="force the admin to change the password on first login",
    )
    p.add_argument(
        "--reset-password",
        action="store_true",
        help="if the user already exists, overwrite its password and make it an active admin",
    )
    p.set_defaults(func=seed_admin)

    students = sub.add_parser("seed-students", help="create the seven demo students")
    students.set_defaults(func=seed_students)

    migrate = sub.add_parser(
        "migrate-to-mongo",
        help="copy the operation log and submission results from Postgres into MongoDB",
    )
    migrate.add_argument(
        "--drop-old",
        action="store_true",
        help="after a verified copy, drop operation_logs, submission_results and submissions.compile_log",
    )
    migrate.add_argument("--yes", action="store_true", help="with --drop-old: do not ask first")
    migrate.set_defaults(func=migrate_to_mongo)

    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
