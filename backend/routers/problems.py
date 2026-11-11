"""Problem management for staff and admins (``/admin/problems``, FR-PRB-01 to 17).

A problem has two kinds of data. Title, slug, statement and test case hints
are edited in place. Everything the judge depends on (limits, languages,
checking mode, max points, reference solution, test cases and what students
see of them) lives in an immutable ``ProblemVersion``: saving a change to any
of it creates the next version and starts its build, and students keep the
current version until that build succeeds (FR-PRB-03, FR-PRB-12).

``PATCH /admin/problems/{id}`` is the editor's one Save call. Its optional
``config`` carries the whole versioned part, so a save is atomic; test inputs
are uploaded beforehand (``POST .../testdata``) and named by SHA-256, because
they can be 8 MiB each.

Not here yet: rejudge (FR-PRB-16), which needs the submission pipeline.
"""

from __future__ import annotations

import hashlib
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from db.models.problem import (
    MAX_HINT_LENGTH,
    MAX_IMAGE_BYTES,
    MAX_TEST_INPUT_BYTES,
    BuildStatus,
    Image,
    Problem,
    ProblemLanguage,
    ProblemStatus,
    ProblemVersion,
    TestCase,
    TestCaseVisibility,
)
from db.models.submission import MAX_SOURCE_BYTES, ProblemScore, Submission
from db.models.user import UserRole
from db.postgres import get_database
from services import storage
from services.auth import CurrentSession, require_role
from services.jobs import enqueue
from services.languages import LANGUAGES
from services.operation_log import log_operation
from services.packages import testdata_key

router = APIRouter(
    prefix="/admin",
    tags=["problems"],
    dependencies=[Depends(require_role(UserRole.staff, UserRole.admin))],
)

Db = Annotated[DbSession, Depends(get_database)]

SLUG_PATTERN = r"^[a-z0-9-]{1,64}$"  # same rule as the problems_slug_check constraint
MAX_TITLE_LENGTH = 200
MAX_STATEMENT_LENGTH = 200_000
MAX_TEST_CASES = 100  # FR-PRB-09
PREVIEW_BYTES = 200  # how much of an input or expected output the editor shows inline
# The detail view reads up to two previews per test case from storage
_PREVIEW_THREADS = 8

# Detected from the file's first bytes, never taken from the upload's own
# Content-Type. SVG is left out until it can be sanitised (FR-PRB-06).
_IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}


# --- request models ---------------------------------------------------------


class ProblemCreate(BaseModel):
    title: str = Field(min_length=1, max_length=MAX_TITLE_LENGTH)
    slug: str = Field(pattern=SLUG_PATTERN)


class LanguageLimit(BaseModel):
    language_id: str
    # None = the version's time limit
    time_limit_ms: Optional[int] = Field(default=None, ge=1, le=60000)


class TestCaseIn(BaseModel):
    input_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    visibility: TestCaseVisibility = TestCaseVisibility.hidden
    hint_md: Optional[str] = Field(default=None, max_length=MAX_HINT_LENGTH)


class ConfigIn(BaseModel):
    """The versioned part of a problem, always sent whole."""

    max_points: int = Field(default=100, ge=1, le=1_000_000)
    time_limit_ms: int = Field(ge=1, le=60000)
    memory_limit_mb: int = Field(ge=1, le=8192)
    checker_strict: bool = True
    float_abs: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    float_rel: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    languages: list[LanguageLimit] = Field(min_length=1)
    reference_language: str
    reference_source: str = Field(min_length=1)
    test_cases: list[TestCaseIn] = Field(min_length=1, max_length=MAX_TEST_CASES)


class ProblemUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=MAX_TITLE_LENGTH)
    slug: Optional[str] = Field(default=None, pattern=SLUG_PATTERN)
    statement_md: Optional[str] = Field(default=None, max_length=MAX_STATEMENT_LENGTH)
    config: Optional[ConfigIn] = None


# --- response models --------------------------------------------------------


class LanguageOut(BaseModel):
    id: str
    display: str


class ProblemListItem(BaseModel):
    id: int
    slug: str
    title: str
    status: ProblemStatus
    # Build of the newest version; None while the problem has no version
    build_status: Optional[BuildStatus]
    can_enable: bool
    languages: list[str]
    submission_count: int  # student submissions only
    updated_at: datetime


class BuildOut(BaseModel):
    status: BuildStatus
    reason: Optional[str]
    failed_testcase: Optional[str]
    log: Optional[str]
    max_ref_time_ms: Optional[int]


class TestCaseOut(BaseModel):
    id: int
    ordinal: int
    input_sha256: str
    input_bytes: int
    input_preview: str
    input_truncated: bool
    # Expected output, known once the build succeeded
    answer_preview: Optional[str]
    answer_truncated: bool
    visibility: TestCaseVisibility
    hint_md: Optional[str]
    ref_time_ms: Optional[int]


class VersionOut(BaseModel):
    id: int
    version: int
    max_points: int
    time_limit_ms: int
    memory_limit_mb: int
    checker_strict: bool
    float_abs: Optional[float]
    float_rel: Optional[float]
    languages: list[LanguageLimit]
    reference_language: str
    reference_source: str
    build: BuildOut
    test_cases: list[TestCaseOut]


class ProblemDetail(BaseModel):
    id: int
    slug: str
    title: str
    statement_md: str
    status: ProblemStatus
    can_enable: bool
    # Number of the version students are judged against, if any
    current_version: Optional[int]
    student_submission_count: int
    updated_at: datetime
    # The newest version, which is what the editor edits; it is not the
    # current one while its build is pending or failed
    version: Optional[VersionOut]


class BuildState(BaseModel):
    """What the editor polls while a build is pending."""

    status: ProblemStatus
    can_enable: bool
    current_version: Optional[int]
    version: Optional[int]
    build: Optional[BuildOut]


class TestDataOut(BaseModel):
    sha256: str
    bytes: int
    preview: str
    truncated: bool


class ImageOut(BaseModel):
    id: int
    mime: str
    bytes: int


# --- helpers ----------------------------------------------------------------


def _get_problem(db: DbSession, problem_id: int, *, lock: bool = False) -> Problem:
    query = select(Problem).where(Problem.id == problem_id)
    if lock:
        # Serialises saves of one problem, so two cannot take the same version number
        query = query.with_for_update()
    problem = db.scalar(query)
    if problem is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Problem not found")
    return problem


def _get_editable(db: DbSession, problem_id: int) -> Problem:
    problem = _get_problem(db, problem_id, lock=True)
    if problem.status is ProblemStatus.archived:
        raise HTTPException(status.HTTP_409_CONFLICT, "Archived problems cannot be changed")
    return problem


def _latest_version(db: DbSession, problem_id: int) -> Optional[ProblemVersion]:
    return db.scalar(
        select(ProblemVersion)
        .where(ProblemVersion.problem_id == problem_id)
        .order_by(ProblemVersion.version.desc())
        .limit(1)
    )


def _can_enable(problem: Problem) -> bool:
    # FR-PRB-03: any past successful build is enough; a pending or failed
    # rebuild leaves the previous good version in place
    return problem.current_version_id is not None and problem.status is not ProblemStatus.archived


def _student_submission_count(db: DbSession, problem_id: int) -> int:
    return db.scalar(
        select(func.count())
        .select_from(Submission)
        .where(Submission.problem_id == problem_id, Submission.is_staff.is_(False))
    ) or 0


def _preview(data: bytes, total: int) -> tuple[str, bool]:
    return data[:PREVIEW_BYTES].decode("utf-8", errors="replace"), total > PREVIEW_BYTES


def _read_preview(key: Optional[str], total: Optional[int]) -> bytes:
    if not key or not total:
        return b""
    return storage.get_bytes(storage.PROBLEMS, key, limit=PREVIEW_BYTES)


def _build_out(version: ProblemVersion) -> BuildOut:
    return BuildOut(
        status=version.build_status,
        reason=version.build_reason,
        failed_testcase=version.build_failed_testcase,
        log=version.build_log,
        max_ref_time_ms=version.max_ref_time_ms,
    )


def _version_out(version: ProblemVersion) -> VersionOut:
    cases = version.test_cases
    built = version.build_status is BuildStatus.ok
    with ThreadPoolExecutor(_PREVIEW_THREADS) as pool:
        source = pool.submit(storage.get_bytes, storage.PROBLEMS, version.reference_source_key)
        inputs = list(pool.map(lambda c: _read_preview(c.input_key, c.input_bytes), cases))
        # Answer columns are filled before the build is confirmed (see
        # packages.record_build_result), so only show them once it is ok
        answers = list(
            pool.map(lambda c: _read_preview(c.answer_key, c.answer_bytes) if built else b"", cases)
        )
        reference_source = source.result().decode("utf-8", errors="replace")

    test_cases = []
    for case, input_data, answer_data in zip(cases, inputs, answers):
        input_preview, input_truncated = _preview(input_data, case.input_bytes)
        answer_preview, answer_truncated = _preview(answer_data, case.answer_bytes or 0)
        test_cases.append(
            TestCaseOut(
                id=case.id,
                ordinal=case.ordinal,
                input_sha256=case.input_sha256,
                input_bytes=case.input_bytes,
                input_preview=input_preview,
                input_truncated=input_truncated,
                answer_preview=answer_preview if built else None,
                answer_truncated=answer_truncated,
                visibility=case.visibility,
                hint_md=case.hint_md,
                ref_time_ms=case.ref_time_ms if built else None,
            )
        )
    return VersionOut(
        id=version.id,
        version=version.version,
        max_points=version.max_points,
        time_limit_ms=version.time_limit_ms,
        memory_limit_mb=version.memory_limit_mb,
        checker_strict=version.checker_strict,
        float_abs=version.float_abs,
        float_rel=version.float_rel,
        languages=[
            LanguageLimit(language_id=lang.language_id, time_limit_ms=lang.time_limit_ms)
            for lang in sorted(version.languages, key=lambda lang: lang.language_id)
        ],
        reference_language=version.reference_language,
        reference_source=reference_source,
        build=_build_out(version),
        test_cases=test_cases,
    )


def _detail(db: DbSession, problem: Problem) -> ProblemDetail:
    latest = _latest_version(db, problem.id)
    current = problem.current_version
    return ProblemDetail(
        id=problem.id,
        slug=problem.slug,
        title=problem.title,
        statement_md=problem.statement_md,
        status=problem.status,
        can_enable=_can_enable(problem),
        current_version=current.version if current else None,
        student_submission_count=_student_submission_count(db, problem.id),
        updated_at=problem.updated_at,
        version=_version_out(latest) if latest else None,
    )


def _check_slug_free(db: DbSession, slug: str, *, except_id: Optional[int] = None) -> None:
    # slug is CITEXT, so this comparison is case-insensitive
    taken = db.scalar(select(Problem.id).where(Problem.slug == slug))
    if taken is not None and taken != except_id:
        raise HTTPException(status.HTTP_409_CONFLICT, "Another problem already uses this URL slug")


def _validate_config(config: ConfigIn) -> None:
    ids = [lang.language_id for lang in config.languages]
    unknown = [language_id for language_id in ids if language_id not in LANGUAGES]
    if unknown:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown language: {unknown[0]}")
    if len(set(ids)) != len(ids):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A language is listed twice")
    # The package holds a time limit per allowed language only, and the judge
    # refuses a build whose reference language has none.
    if config.reference_language not in ids:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "The reference solution's language must be one of the allowed languages",
        )
    if len(config.reference_source.encode()) > MAX_SOURCE_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The reference solution is larger than 64 KB")


def _same_judging(config: ConfigIn, version: ProblemVersion) -> bool:
    """True when ``config`` would build the same package as ``version`` (hints aside)."""
    languages = {lang.language_id: lang.time_limit_ms for lang in version.languages}
    if (
        config.max_points != version.max_points
        or config.time_limit_ms != version.time_limit_ms
        or config.memory_limit_mb != version.memory_limit_mb
        or config.checker_strict != version.checker_strict
        or config.float_abs != version.float_abs
        or config.float_rel != version.float_rel
        or config.reference_language != version.reference_language
        or {lang.language_id: lang.time_limit_ms for lang in config.languages} != languages
        or [(case.input_sha256, case.visibility) for case in config.test_cases]
        != [(case.input_sha256, case.visibility) for case in version.test_cases]
    ):
        return False
    stored = storage.get_bytes(storage.PROBLEMS, version.reference_source_key)
    return stored == config.reference_source.encode()


def _add_version(
    db: DbSession,
    problem: Problem,
    latest: Optional[ProblemVersion],
    config: ConfigIn,
    user_id: int,
) -> ProblemVersion:
    """Create the next version from ``config`` (uploads the reference; caller commits)."""
    # Inputs carried over from the previous version are known to exist;
    # anything else must have been uploaded through POST .../testdata.
    known = {case.input_sha256: case.input_bytes for case in latest.test_cases} if latest else {}
    sizes: dict[str, int] = {}
    for number, case in enumerate(config.test_cases, start=1):
        sha256 = case.input_sha256
        if sha256 not in sizes:
            size = known.get(sha256)
            if size is None:
                size = storage.size(storage.PROBLEMS, testdata_key(sha256))
            if size is None:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, f"The input of test {number} was not uploaded"
                )
            sizes[sha256] = size

    version = ProblemVersion(
        problem_id=problem.id,
        version=latest.version + 1 if latest else 1,
        max_points=config.max_points,
        time_limit_ms=config.time_limit_ms,
        memory_limit_mb=config.memory_limit_mb,
        checker_strict=config.checker_strict,
        float_abs=config.float_abs,
        float_rel=config.float_rel,
        reference_language=config.reference_language,
        reference_source_key="",  # needs the id; set right below
        created_by=user_id,
    )
    db.add(version)
    db.flush()
    source_name = LANGUAGES[config.reference_language].source_name
    version.reference_source_key = f"reference/{version.id}/{source_name}"
    version.languages = [
        ProblemLanguage(language_id=lang.language_id, time_limit_ms=lang.time_limit_ms)
        for lang in config.languages
    ]
    version.test_cases = [
        TestCase(
            ordinal=ordinal,
            name=str(ordinal),
            input_key=testdata_key(case.input_sha256),
            input_sha256=case.input_sha256,
            input_bytes=sizes[case.input_sha256],
            visibility=case.visibility,
            hint_md=case.hint_md or None,
        )
        for ordinal, case in enumerate(config.test_cases, start=1)
    ]
    # Upload before the commit: a crash in between leaves an unused file,
    # never a version that points at nothing.
    storage.put_bytes(
        storage.PROBLEMS,
        version.reference_source_key,
        config.reference_source.encode(),
        "text/plain; charset=utf-8",
    )
    return version


def _commit_slug(db: DbSession) -> None:
    try:
        db.commit()
    except IntegrityError:
        # Two saves raced for the same slug; the unique index decided
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Another problem already uses this URL slug")


# --- endpoints --------------------------------------------------------------


@router.get("/languages", response_model=list[LanguageOut])
def list_languages():
    return [LanguageOut(id=lang.id, display=lang.display) for lang in LANGUAGES.values()]


@router.get("/problems", response_model=list[ProblemListItem])
def list_problems(db: Db):
    problems = db.scalars(select(Problem).order_by(Problem.id)).all()

    newest = (
        select(ProblemVersion.problem_id, func.max(ProblemVersion.version).label("version"))
        .group_by(ProblemVersion.problem_id)
        .subquery()
    )
    latest = {
        version.problem_id: version
        for version in db.scalars(
            select(ProblemVersion).join(
                newest,
                (ProblemVersion.problem_id == newest.c.problem_id)
                & (ProblemVersion.version == newest.c.version),
            )
        )
    }
    languages: dict[int, list[str]] = {}
    for version_id, language_id in db.execute(
        select(ProblemLanguage.problem_version_id, ProblemLanguage.language_id)
        .where(ProblemLanguage.problem_version_id.in_([v.id for v in latest.values()]))
        .order_by(ProblemLanguage.language_id)
    ):
        languages.setdefault(version_id, []).append(language_id)
    counts = dict(
        db.execute(
            select(Submission.problem_id, func.count())
            .where(Submission.is_staff.is_(False))
            .group_by(Submission.problem_id)
        ).all()
    )

    items = []
    for problem in problems:
        version = latest.get(problem.id)
        items.append(
            ProblemListItem(
                id=problem.id,
                slug=problem.slug,
                title=problem.title,
                status=problem.status,
                build_status=version.build_status if version else None,
                can_enable=_can_enable(problem),
                languages=languages.get(version.id, []) if version else [],
                submission_count=counts.get(problem.id, 0),
                updated_at=problem.updated_at,
            )
        )
    return items


@router.post("/problems", response_model=ProblemDetail, status_code=status.HTTP_201_CREATED)
def create_problem(body: ProblemCreate, session: CurrentSession, db: Db):
    """Create an empty draft; the editor fills in the rest."""
    _check_slug_free(db, body.slug)
    problem = Problem(title=body.title.strip() or body.title, slug=body.slug, author_id=session.user_id)
    db.add(problem)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Another problem already uses this URL slug")
    log_operation(
        db, "problem.create", user_id=session.user_id,
        info={"problem_id": problem.id, "slug": problem.slug},
    )
    db.commit()
    return _detail(db, problem)


@router.get("/problems/{problem_id}", response_model=ProblemDetail)
def get_problem(problem_id: int, db: Db):
    return _detail(db, _get_problem(db, problem_id))


@router.patch("/problems/{problem_id}", response_model=ProblemDetail)
def update_problem(problem_id: int, body: ProblemUpdate, session: CurrentSession, db: Db):
    """Save the editor. Creates a version and starts a build only when judging changes."""
    problem = _get_editable(db, problem_id)

    if body.title is not None:
        problem.title = body.title.strip() or body.title
    if body.slug is not None and body.slug != problem.slug:
        _check_slug_free(db, body.slug, except_id=problem.id)
        problem.slug = body.slug
    if body.statement_md is not None:
        problem.statement_md = body.statement_md

    created: Optional[ProblemVersion] = None
    if body.config is not None:
        _validate_config(body.config)
        latest = _latest_version(db, problem.id)
        if latest is not None and _same_judging(body.config, latest):
            # FR-PRB-11: hints are the one thing edited on an existing version
            for case, sent in zip(latest.test_cases, body.config.test_cases):
                case.hint_md = sent.hint_md or None
        else:
            created = _add_version(db, problem, latest, body.config, session.user_id)

    # onupdate only fires when a problems column changed; a save that only
    # made a version or edited a hint still counts as an update
    problem.updated_at = func.now()
    log_operation(
        db, "problem.update", user_id=session.user_id,
        info={"problem_id": problem.id, "new_version": created.version if created else None},
    )
    _commit_slug(db)
    if created is not None:
        enqueue("start_build", created.id)
    return _detail(db, problem)


@router.delete("/problems/{problem_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_problem(problem_id: int, session: CurrentSession, db: Db):
    """Delete a problem nobody has submitted to; otherwise it can only be archived (FR-PRB-15)."""
    problem = _get_problem(db, problem_id, lock=True)
    refused = HTTPException(
        status.HTTP_409_CONFLICT,
        "This problem has student submissions and cannot be deleted. Archive it instead.",
    )
    if _student_submission_count(db, problem.id):
        raise refused

    info = {"problem_id": problem.id, "slug": problem.slug, "title": problem.title}
    # Staff test submissions do not block deletion: they go with the problem
    db.execute(delete(ProblemScore).where(ProblemScore.problem_id == problem.id))
    db.execute(delete(Submission).where(Submission.problem_id == problem.id))
    # The problem and its versions reference each other; break the cycle first
    problem.current_version = None
    db.flush()
    db.delete(problem)
    log_operation(db, "problem.delete", user_id=session.user_id, info=info)
    try:
        db.commit()
    except IntegrityError:
        # A student submitted between the count and the delete (ON DELETE RESTRICT)
        db.rollback()
        raise refused
    # Stored files are left for the orphan sweep (docs/data-and-storage.md)


def _set_status(
    db: DbSession, problem: Problem, new_status: ProblemStatus, user_id: int, action: str
) -> ProblemDetail:
    if problem.status is not new_status:
        problem.status = new_status
        log_operation(db, f"problem.{action}", user_id=user_id, info={"problem_id": problem.id})
        db.commit()
    return _detail(db, problem)


@router.post("/problems/{problem_id}/enable", response_model=ProblemDetail)
def enable_problem(problem_id: int, session: CurrentSession, db: Db):
    problem = _get_editable(db, problem_id)
    if problem.current_version_id is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "A problem can be enabled once a build has succeeded"
        )
    return _set_status(db, problem, ProblemStatus.enabled, session.user_id, "enable")


@router.post("/problems/{problem_id}/disable", response_model=ProblemDetail)
def disable_problem(problem_id: int, session: CurrentSession, db: Db):
    problem = _get_editable(db, problem_id)
    if problem.status is not ProblemStatus.enabled:
        return _detail(db, problem)  # a draft stays a draft
    return _set_status(db, problem, ProblemStatus.disabled, session.user_id, "disable")


@router.post("/problems/{problem_id}/archive", response_model=ProblemDetail)
def archive_problem(problem_id: int, session: CurrentSession, db: Db):
    """Disable for good; used instead of delete once students have submitted."""
    problem = _get_problem(db, problem_id, lock=True)
    return _set_status(db, problem, ProblemStatus.archived, session.user_id, "archive")


@router.get("/problems/{problem_id}/build", response_model=BuildState)
def get_build(problem_id: int, db: Db):
    """Build state only, without touching storage: cheap enough to poll every 2 s."""
    problem = _get_problem(db, problem_id)
    latest = _latest_version(db, problem.id)
    current = problem.current_version
    return BuildState(
        status=problem.status,
        can_enable=_can_enable(problem),
        current_version=current.version if current else None,
        version=latest.version if latest else None,
        build=_build_out(latest) if latest else None,
    )


@router.post("/problems/{problem_id}/build", response_model=ProblemDetail)
def rebuild_problem(problem_id: int, session: CurrentSession, db: Db):
    """Build the newest version again, as a new version (a built one is immutable)."""
    problem = _get_editable(db, problem_id)
    latest = _latest_version(db, problem.id)
    if latest is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Save a reference solution and test cases first"
        )
    if latest.build_status is BuildStatus.pending:
        raise HTTPException(status.HTTP_409_CONFLICT, "A build is already waiting for the judge")

    version = ProblemVersion(
        problem_id=problem.id,
        version=latest.version + 1,
        max_points=latest.max_points,
        time_limit_ms=latest.time_limit_ms,
        memory_limit_mb=latest.memory_limit_mb,
        checker_strict=latest.checker_strict,
        float_abs=latest.float_abs,
        float_rel=latest.float_rel,
        reference_language=latest.reference_language,
        # Stored objects never change, so both versions can share the file
        reference_source_key=latest.reference_source_key,
        created_by=session.user_id,
        languages=[
            ProblemLanguage(language_id=lang.language_id, time_limit_ms=lang.time_limit_ms)
            for lang in latest.languages
        ],
        test_cases=[
            TestCase(
                ordinal=case.ordinal,
                name=case.name,
                input_key=case.input_key,
                input_sha256=case.input_sha256,
                input_bytes=case.input_bytes,
                visibility=case.visibility,
                hint_md=case.hint_md,
            )
            for case in latest.test_cases
        ],
    )
    db.add(version)
    problem.updated_at = func.now()
    log_operation(
        db, "problem.build", user_id=session.user_id,
        info={"problem_id": problem.id, "new_version": version.version},
    )
    db.commit()
    enqueue("start_build", version.id)
    return _detail(db, problem)


@router.post("/problems/{problem_id}/testdata", response_model=TestDataOut)
def upload_testdata(problem_id: int, file: UploadFile, db: Db):
    """Store one test input and return the hash a later save refers to it by."""
    _get_editable(db, problem_id)
    data = file.file.read(MAX_TEST_INPUT_BYTES + 1)
    if len(data) > MAX_TEST_INPUT_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "A test input can be at most 8 MB"
        )
    sha256 = hashlib.sha256(data).hexdigest()
    key = testdata_key(sha256)
    # Content-addressed: the same input is stored once, whichever problem uses it
    if storage.size(storage.PROBLEMS, key) is None:
        storage.put_bytes(storage.PROBLEMS, key, data, "application/octet-stream")
    preview, truncated = _preview(data, len(data))
    return TestDataOut(sha256=sha256, bytes=len(data), preview=preview, truncated=truncated)


def _sniff_image(data: bytes) -> Optional[str]:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


@router.post(
    "/problems/{problem_id}/images", response_model=ImageOut, status_code=status.HTTP_201_CREATED
)
def upload_image(problem_id: int, file: UploadFile, session: CurrentSession, db: Db):
    """Store a statement image; the statement links it as ``/api/images/{id}``."""
    problem = _get_editable(db, problem_id)
    data = file.file.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "An image can be at most 5 MB")
    mime = _sniff_image(data)
    if mime is None:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Images must be PNG, JPEG, GIF or WebP"
        )

    key = f"images/{problem.id}/{uuid.uuid4().hex}.{_IMAGE_TYPES[mime]}"
    storage.put_bytes(storage.ASSETS, key, data, mime)
    image = Image(
        problem_id=problem.id,
        object_key=key,
        mime=mime,
        bytes=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        uploaded_by=session.user_id,
    )
    db.add(image)
    db.commit()
    return ImageOut(id=image.id, mime=image.mime, bytes=image.bytes)
