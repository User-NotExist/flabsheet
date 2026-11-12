"""Issue initial student credentials for both the management API and seed CLI.

Add the User returned by new_student() to the caller's transaction and hand
the plaintext password to the creator only after that transaction commits.
"""

from __future__ import annotations

import secrets
import string

from argon2 import PasswordHasher

from db.models.user import User, UserRole

_hasher = PasswordHasher()


def reset_student_password(user: User) -> str:
    alphabet = string.ascii_letters + string.digits
    password = "-".join(
        "".join(secrets.choice(alphabet) for _ in range(5)) for _ in range(3)
    )
    user.password_hash = _hasher.hash(password)
    user.must_change_password = True
    return password


def new_student(
    login_id: str, display_name: str, created_by: int | None, *, is_active: bool = True
) -> tuple[User, str]:
    user = User(
        login_id=login_id,
        display_name=display_name,
        created_by=created_by,
        role=UserRole.student,
        is_active=is_active,
    )
    return user, reset_student_password(user)
