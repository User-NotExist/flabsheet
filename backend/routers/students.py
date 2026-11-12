"""Manage student rows in users. POST /students/import returns credentials once.

Both the single-account and CSV paths use the same field validation and
password generation. Only a staff or admin session may call these routes.
"""

from __future__ import annotations

import csv
import io
from concurrent.futures import ThreadPoolExecutor
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile
from pydantic import BaseModel, ConfigDict, StringConstraints, ValidationError
from psycopg.errors import UniqueViolation
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from db.models.student_import import StudentImport
from db.models.user import User, UserRole
from db.postgres import get_database
from services.auth import require_role
from services.errors import ApiError
from services.operation_log import log_operation
from services.session import SessionData, invalidate_user_sessions, revoke_user_sessions
from services.students import new_student, reset_student_password

router = APIRouter(prefix="/students", tags=["students"])
# Each Argon2id job uses 64 MiB; share this limit across concurrent imports.
_import_hashers = ThreadPoolExecutor(max_workers=4, thread_name_prefix="student-import")
Db = Annotated[DbSession, Depends(get_database)]
Staff = Annotated[SessionData, Depends(require_role(UserRole.staff, UserRole.admin))]
StudentId = Annotated[
    str, StringConstraints(strip_whitespace=True, pattern=r"^[A-Za-z0-9._-]{1,64}$")
]
DisplayName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=100, pattern=r"^[^\x00]+$"),
]


class StudentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    student_id: StudentId
    display_name: DisplayName


class StudentPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: DisplayName | None = None
    is_active: bool | None = None


class StudentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    login_id: str
    display_name: str
    is_active: bool


class StudentCredential(BaseModel):
    student: StudentOut
    password: str


@router.get("", response_model=list[StudentOut])
def list_students(db: Db, session: Staff):
    query = (
        select(User.id, User.login_id, User.display_name, User.is_active)
        .where(User.role == UserRole.student)
        .order_by(User.login_id)
    )
    return db.execute(query).mappings().all()


@router.post("", response_model=StudentCredential, status_code=201)
def create_student(body: StudentCreate, db: Db, session: Staff, response: Response):
    student, password = new_student(body.student_id, body.display_name, session.user_id)
    db.add(student)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        if isinstance(exc.orig, UniqueViolation):
            raise HTTPException(409, "That student ID already exists.") from exc
        raise
    log_operation(db, "student.create", user_id=session.user_id, info={"student_id": student.id})
    db.commit()
    response.headers["Cache-Control"] = "no-store"
    return StudentCredential(student=StudentOut.model_validate(student), password=password)


def _student_for_update(db: DbSession, user_id: int) -> User:
    query = select(User).where(User.id == user_id, User.role == UserRole.student).with_for_update()
    student = db.scalar(query)
    if student is None:
        raise HTTPException(404, "Student not found.")
    return student


@router.patch("/{user_id}", response_model=StudentOut)
def edit_student(user_id: int, body: StudentPatch, db: Db, session: Staff):
    if body.display_name is None and body.is_active is None:
        raise HTTPException(422, "Enter a display name or an active status.")
    student = _student_for_update(db, user_id)
    if body.display_name is not None:
        student.display_name = body.display_name
    if body.is_active is not None:
        student.is_active = body.is_active
    log_operation(
        db, "student.edit", user_id=session.user_id,
        info={"student_id": user_id, **body.model_dump(exclude_none=True)},
    )
    if body.is_active is False:
        revoke_user_sessions(db, user_id)
    else:
        db.commit()
        invalidate_user_sessions(db, user_id)
    return student


@router.post("/{user_id}/reset-password", response_model=StudentCredential)
def reset_password(user_id: int, db: Db, session: Staff, response: Response):
    student = _student_for_update(db, user_id)
    password = reset_student_password(student)
    log_operation(db, "student.reset_password", user_id=session.user_id, info={"student_id": user_id})
    revoke_user_sessions(db, user_id)
    response.headers["Cache-Control"] = "no-store"
    return StudentCredential(student=StudentOut.model_validate(student), password=password)


def _invalid_csv(detail: str) -> ApiError:
    return ApiError(422, detail, code="csv_invalid")


def _existing_id_errors(db: DbSession, rows: dict[int, StudentCreate]) -> list[str]:
    ids = [row.student_id for row in rows.values()]
    existing: set[str] = set()
    # Bound the number of parameters per statement for large input files.
    for start in range(0, len(ids), 1000):
        query = select(User.login_id).where(User.login_id.in_(ids[start:start + 1000]))
        existing.update(login_id.lower() for login_id in db.scalars(query))
    return [
        f"Row {line}: student ID {row.student_id} already exists."
        for line, row in rows.items() if row.student_id.lower() in existing
    ]


def _read_import(file: UploadFile, db: DbSession) -> dict[int, StudentCreate]:
    rows: dict[int, StudentCreate] = {}
    first_seen: dict[str, int] = {}
    errors: list[str] = []
    # Stream the spooled upload so a second copy of the whole file isn't needed.
    source = io.TextIOWrapper(file.file, encoding="utf-8-sig", newline="")
    reader = csv.reader(source, strict=True)
    try:
        if next(reader, None) != ["display_name", "student_id"]:
            raise _invalid_csv("Row 1: expected the header display_name,student_id.")
        for fields in reader:
            line = reader.line_num
            if len(fields) != 2:
                errors.append(f"Row {line}: expected display name and student ID.")
                continue
            try:
                row = StudentCreate(display_name=fields[0], student_id=fields[1])
            except ValidationError as exc:
                messages = {
                    "student_id": "enter a student ID of 1–64 letters, digits, dots, dashes or underscores",
                    "display_name": "enter a display name of 1–100 characters",
                }
                detail = ", ".join(messages[str(error["loc"][0])] for error in exc.errors())
                errors.append(f"Row {line}: {detail}.")
                continue
            key = row.student_id.lower()
            if key in first_seen:
                errors.append(f"Row {line}: student ID {row.student_id} duplicates row {first_seen[key]}.")
            else:
                first_seen[key] = line
            rows[line] = row
    except UnicodeDecodeError as exc:
        raise _invalid_csv("Upload a UTF-8 encoded CSV file.") from exc
    except csv.Error as exc:
        raise _invalid_csv(f"Row {reader.line_num}: invalid CSV ({exc}).") from exc
    finally:
        source.detach()  # FastAPI owns the upload's underlying file.
    errors.extend(_existing_id_errors(db, rows))
    if errors:
        raise _invalid_csv("\n".join(errors))
    if not rows:
        raise _invalid_csv("Add at least one student below the header.")
    return rows


def _csv_text(value: str) -> str:
    # A quoted CSV field is still executed as a formula by spreadsheet apps.
    if value.startswith(("=", "+", "-", "@", "＝", "＋", "－", "＠")):
        return "'" + value
    return value


@router.post("/import", response_class=Response)
def import_students(file: UploadFile, db: Db, session: Staff) -> Response:
    rows = _read_import(file, db)
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["student_id", "display_name", "password"])
    def prepare(row: StudentCreate) -> tuple[User, str]:
        return new_student(row.student_id, row.display_name, session.user_id)

    for student, password in _import_hashers.map(prepare, rows.values()):
        db.add(student)
        writer.writerow([_csv_text(student.login_id), _csv_text(student.display_name), password])
    db.add(StudentImport(staff_id=session.user_id, row_count=len(rows)))
    try:
        log_operation(db, "student.import", user_id=session.user_id, info={"row_count": len(rows)})
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if isinstance(exc.orig, UniqueViolation):
            # A login ID may have been claimed by another transaction after validation.
            errors = _existing_id_errors(db, rows)
            raise _invalid_csv("\n".join(errors) or "A student ID already exists.") from exc
        raise
    return Response(output.getvalue(), media_type="text/csv", headers={
        "Content-Disposition": 'attachment; filename="student-passwords.csv"',
        "Cache-Control": "no-store",
    })
