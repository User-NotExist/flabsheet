"""Problem packages: ``problem.yaml``, the staging and final zips, and the build steps.

A version's build goes through three steps (SRS section 6.3, package format in
``judge-worker-go/README.md``):

1. :func:`start_build` zips ``problem.yaml`` and the test inputs into
   ``staging/{sha256}.zip`` and sends the judge a build job, which runs the
   reference solution and uploads one ``answers/{version_id}/{n}.ans`` each.
2. :func:`record_build_result` stores what the judge's ``build_done`` event
   reported. A failed build ends here.
3. :func:`assemble_package` checks every answer against the reported hash,
   uploads ``packages/{sha256}.zip`` with the answers added, marks the version
   ``ok`` and makes it the problem's current version.

Steps 1 and 3 touch storage for a long time, so they run in the worker
(``worker.py``). Each step leaves a state the worker's cron can find again
(:func:`pending_build_ids`, :func:`pending_assembly_ids`), and each is safe to
run twice: it locks the version row and returns when the step is already done.

    start_build(version.id)        # worker job, after the version is committed
    assemble_package(version.id)   # worker job, after build_done ok
"""

from __future__ import annotations

import hashlib
import json
import logging
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from typing import Any, BinaryIO, Mapping, Optional

from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from db.models.problem import BuildStatus, Problem, ProblemVersion, TestCase
from db.models.submission import JudgeOutbox
from db.postgres import SessionLocal
from services import storage
from services.judge import BUILD_STREAM, new_job_id, send_outbox
from services.languages import LANGUAGES

logger = logging.getLogger(__name__)

MAX_BUILD_LOG_CHARS = 64 * 1024  # the judge caps compiler logs at 64 KiB
# The cron leaves younger versions to the job their own request enqueued
PENDING_GRACE_SECONDS = 5
# Zips larger than this spill from memory to a temporary file
_ZIP_SPOOL_BYTES = 32 * 1024 * 1024
# Fixed entry timestamp: the same content must always give the same SHA-256
_ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)


def testdata_key(sha256: str) -> str:
    return f"testdata/{sha256}.in"


def answer_key(version_id: int, name: str) -> str:
    return f"answers/{version_id}/{name}.ans"


def language_time_limits(version: ProblemVersion) -> dict[str, int]:
    """Time limit per allowed language: its override, else the version's limit."""
    return {
        lang.language_id: lang.time_limit_ms or version.time_limit_ms
        for lang in sorted(version.languages, key=lambda lang: lang.language_id)
    }


def problem_yaml(version: ProblemVersion) -> str:
    """``problem.yaml`` for the version. JSON scalars are valid YAML scalars."""
    lines = ["type: batch", "limits:", f"  memory_mb: {version.memory_limit_mb}", "  time_ms:"]
    for language_id, time_ms in language_time_limits(version).items():
        lines.append(f"    {json.dumps(language_id)}: {time_ms}")
    lines += ["checker:", "  kind: default", f"  strict: {json.dumps(version.checker_strict)}"]
    if version.float_abs is not None:
        lines.append(f"  float_abs: {version.float_abs!r}")
    if version.float_rel is not None:
        lines.append(f"  float_rel: {version.float_rel!r}")
    lines.append("testcases:")
    names = []
    for case in version.test_cases:
        names.append(json.dumps(case.name))
        # The judge returns output previews for `sample: true` cases only, and
        # students may see the output of both sample and visible cases.
        sample = ", sample: true" if case.visibility.value != "hidden" else ""
        lines.append(f"  - {{ name: {json.dumps(case.name)}{sample} }}")
    # FR-JDG-04: one `sum` subtask, so score = max points x fraction of cases passed
    lines += [
        "subtasks:",
        f"  - {{ index: 0, points: {version.max_points}, mode: sum, testcases: [{', '.join(names)}] }}",
    ]
    return "\n".join(lines) + "\n"


def _add_entry(archive: zipfile.ZipFile, name: str, data: bytes) -> None:
    info = zipfile.ZipInfo(name, date_time=_ZIP_EPOCH)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    archive.writestr(info, data)


def _write_package(out: BinaryIO, version: ProblemVersion, answers: Mapping[str, bytes]) -> str:
    """Write the package zip to ``out`` and return its SHA-256.

    Without ``answers`` this is the staging package. Entries are written in a
    fixed order with fixed metadata, so a retry lands on the same storage key.
    """
    with zipfile.ZipFile(out, "w") as archive:
        _add_entry(archive, "problem.yaml", problem_yaml(version).encode())
        for case in version.test_cases:
            data = storage.get_bytes(storage.PROBLEMS, case.input_key) if case.input_bytes else b""
            _add_entry(archive, f"tests/{case.name}.in", data)
            if case.name in answers:
                _add_entry(archive, f"tests/{case.name}.ans", answers[case.name])
    out.seek(0)
    digest = hashlib.sha256()
    while chunk := out.read(1024 * 1024):
        digest.update(chunk)
    out.seek(0)
    return digest.hexdigest()


def _upload_package(prefix: str, version: ProblemVersion, answers: Mapping[str, bytes]) -> tuple[str, str]:
    """Build and upload a package; returns ``(sha256, key)``."""
    with tempfile.SpooledTemporaryFile(max_size=_ZIP_SPOOL_BYTES) as out:
        sha256 = _write_package(out, version, answers)  # type: ignore[arg-type]
        key = f"{prefix}/{sha256}.zip"
        storage.put_file(storage.PROBLEMS, key, out, "application/zip")  # type: ignore[arg-type]
    return sha256, key


def build_job_payload(version: ProblemVersion) -> dict[str, Any]:
    """The BuildJob JSON for a version whose staging package is uploaded.

    Used for the first send, for outbox retries and for the judge's refresh
    call, so all three always agree apart from the freshly signed URLs.
    """
    language = LANGUAGES[version.reference_language]
    source = storage.get_bytes(storage.PROBLEMS, version.reference_source_key)
    return {
        "kind": "build",
        "job_id": version.build_job_id,
        "problem": {
            "id": version.problem_id,
            "version": version.version,
            "package_sha256": version.package_sha256,
            "package_key": version.package_key,
        },
        "reference": {
            "language": language.id,
            "files": [
                {
                    "name": language.source_name,
                    "url": storage.presign_get(storage.PROBLEMS, version.reference_source_key),
                    "sha256": hashlib.sha256(source).hexdigest(),
                }
            ],
        },
        "limits": {
            "time_ms": language_time_limits(version)[language.id],
            "memory_mb": version.memory_limit_mb,
        },
        # The judge's storage key is read-only: answers go through these URLs
        "answers_upload": {
            f"{case.name}.ans": storage.presign_put(
                storage.PROBLEMS, answer_key(version.id, case.name)
            )
            for case in version.test_cases
        },
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def refreshed_build_payload(db: Session, job_id: str) -> Optional[dict[str, Any]]:
    """The build job with fresh URLs, or None when it is no longer wanted."""
    version = db.scalar(select(ProblemVersion).where(ProblemVersion.build_job_id == job_id))
    if version is None or version.build_status is not BuildStatus.pending:
        return None
    return build_job_payload(version)


def _lock_pending(db: Session, version_id: int) -> Optional[ProblemVersion]:
    # SKIP LOCKED: when the enqueued job and the cron pick the same version,
    # the second one leaves instead of repeating the work.
    version = db.scalar(
        select(ProblemVersion)
        .where(ProblemVersion.id == version_id)
        .with_for_update(skip_locked=True)
    )
    if version is None or version.build_status is not BuildStatus.pending:
        return None
    return version


def _fail(version: ProblemVersion, reason: str, log: Optional[str] = None) -> None:
    version.build_status = BuildStatus.failed
    version.build_reason = reason
    version.build_log = log[:MAX_BUILD_LOG_CHARS] if log else None


def start_build(version_id: int) -> None:
    """Step 1: upload the staging package and send the build job."""
    with SessionLocal() as db:
        version = _lock_pending(db, version_id)
        if version is None or version.build_job_id is not None:
            return

        newer = db.scalar(
            select(
                exists().where(
                    ProblemVersion.problem_id == version.problem_id,
                    ProblemVersion.version > version.version,
                )
            )
        )
        if newer:
            # Staff saved again before this build started; only the newest
            # version is worth the judge's time.
            _fail(version, "superseded")
            db.commit()
            return

        # While the build is pending these two columns hold the staging
        # package (the build job names it); assemble_package replaces them.
        version.package_sha256, version.package_key = _upload_package("staging", version, {})
        version.build_job_id = new_job_id()
        row = JudgeOutbox(
            job_id=version.build_job_id,
            stream=BUILD_STREAM,
            payload=build_job_payload(version),
        )
        db.add(row)
        db.commit()
        send_outbox(db, row)


def record_build_result(version: ProblemVersion, payload: Mapping[str, Any]) -> bool:
    """Step 2: store a ``build_done`` payload on a pending version.

    Returns True when the answers are ready for :func:`assemble_package`. The
    caller holds the row lock and commits.
    """
    max_time_ms = payload.get("max_time_ms")
    version.max_ref_time_ms = max_time_ms if isinstance(max_time_ms, int) else None

    if payload.get("ok") is not True:
        log = payload.get("log") or payload.get("detail")
        _fail(version, str(payload.get("reason") or "unknown"), str(log) if log else None)
        testcase = payload.get("testcase")
        version.build_failed_testcase = str(testcase) if testcase else None
        return False

    answers = {
        str(answer.get("name", "")).removesuffix(".ans"): answer
        for answer in payload.get("answers") or []
        if isinstance(answer, dict)
    }
    for case in version.test_cases:
        answer = answers.get(case.name)
        sha256 = answer.get("sha256") if answer else None
        if not isinstance(sha256, str) or len(sha256) != 64:
            _fail(version, "answers_incomplete")
            version.build_failed_testcase = case.name
            return False
        # Filled in while the build is still pending: a pending version whose
        # cases carry an answer hash is one that waits for assemble_package.
        case.answer_key = answer_key(version.id, case.name)
        case.answer_sha256 = sha256
        case.answer_bytes = int(answer.get("bytes") or 0)
        time_ms = answer.get("time_ms")
        case.ref_time_ms = time_ms if isinstance(time_ms, int) else None
    return True


def assemble_package(version_id: int) -> None:
    """Step 3: verify the answers, upload the final package, make it current."""
    with SessionLocal() as db:
        version = _lock_pending(db, version_id)
        if version is None or not version.test_cases:
            return
        if any(case.answer_sha256 is None for case in version.test_cases):
            return  # build_done has not arrived yet

        answers: dict[str, bytes] = {}
        for case in version.test_cases:
            assert case.answer_key is not None
            data = storage.get_bytes(storage.PROBLEMS, case.answer_key) if case.answer_bytes else b""
            # The judge wrote these through presigned URLs; check that what is
            # stored is what it says it wrote before students are judged on it.
            if hashlib.sha256(data).hexdigest() != case.answer_sha256:
                _fail(version, "answer_hash_mismatch")
                version.build_failed_testcase = case.name
                db.commit()
                return
            answers[case.name] = data

        version.package_sha256, version.package_key = _upload_package("packages", version, answers)
        version.build_status = BuildStatus.ok

        problem = db.scalar(
            select(Problem).where(Problem.id == version.problem_id).with_for_update()
        )
        assert problem is not None
        current = problem.current_version
        # Builds can finish out of order; the current version only moves forward
        if current is None or current.version < version.version:
            problem.current_version = version
        db.commit()
        logger.info("problem %s version %s built", version.problem_id, version.version)


def pending_build_ids(db: Session) -> list[int]:
    """Versions whose build never started (the enqueue or the storage call failed)."""
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=PENDING_GRACE_SECONDS)
    return list(
        db.scalars(
            select(ProblemVersion.id).where(
                ProblemVersion.build_status == BuildStatus.pending,
                ProblemVersion.build_job_id.is_(None),
                ProblemVersion.created_at < cutoff,
            )
        )
    )


def pending_assembly_ids(db: Session) -> list[int]:
    """Versions whose build_done arrived but whose final package is not uploaded."""
    return list(
        db.scalars(
            select(ProblemVersion.id).where(
                ProblemVersion.build_status == BuildStatus.pending,
                exists().where(
                    TestCase.problem_version_id == ProblemVersion.id,
                    TestCase.answer_sha256.is_not(None),
                ),
            )
        )
    )
