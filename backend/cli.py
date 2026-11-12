"""Management CLI for the flabsheet backend.

Usage:
    uv run python cli.py seed-admin --login-id admin --display-name "Administrator"
    uv run python cli.py seed-students

The admin password comes from ADMIN_PASSWORD or an interactive prompt.
Seeded students receive individual, generated first-login passwords.
"""

from __future__ import annotations

import argparse
import getpass
import os
import re
import sys

from argon2 import PasswordHasher
from psycopg.errors import UniqueViolation
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

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


def seed_admin(args: argparse.Namespace) -> None:
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cli.py", description="flabsheet backend management")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("seed-admin", help="create the initial admin user")
    p.add_argument("--login-id", default="admin", help="login id (default: admin)")
    p.add_argument("--display-name", default="Administrator", help="display name (default: Administrator)")
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

    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
