# AGENTS.md — backend

**Never read `backend/.env`.** Use `.env.example` and `config.py` to see which settings exist. Also read the root [AGENTS.md](../AGENTS.md).

FastAPI service, Python 3.12, managed with **uv**. It uses sync SQLAlchemy 2.x (psycopg 3) on PostgreSQL and sync redis-py. Passwords are hashed with argon2. RustFS/S3 goes through sync `boto3` (`services/storage.py`). Background jobs run in a second process, an **arq** worker (`worker.py`).

## Commands

```sh
uv sync                                   # install into .venv
uv run fastapi dev main.py                # http://localhost:8000, docs at /docs (needs postgres+redis up)
uv run arq worker.WorkerSettings          # background worker (needs redis+rustfs up, and the schema the API creates)
uv run python cli.py seed-admin           # create the first admin (password from ADMIN_PASSWORD or a prompt)
uv add <pkg>                              # add a dependency (updates pyproject.toml + uv.lock)
uv run python -m compileall -q .          # quick syntax check
```

- There is **no test suite, linter or formatter config yet**. Don't add one unless asked. Match the existing style by hand.
- Under compose, the backend and the `worker` service run in containers (`docker compose -f ../compose.dev.yaml exec backend …`), and `POSTGRES_URL`/`REDIS_URL`/`S3_ENDPOINT_URL` and the S3 keys are overridden to point at the service names.

## Layout

```
main.py                 app, CORS, schema setup at import (CREATE EXTENSION citext + create_all), routers
config.py               pydantic-settings `Settings`; module-level `settings` singleton
cli.py                  management CLI (argparse subcommands): seed-admin
db/postgres.py          engine, SessionLocal, Base, get_database() dependency
db/redis.py             shared redis_client (decode_responses=True, 2 s timeouts), get_redis()
db/models/user.py       User, Session (login sessions), UserRole enum
db/models/operation_log.py  OperationLog (audit rows)
db/models/student_import.py StudentImport (bulk import runs; never stores passwords)
db/models/problem.py    Problem, ProblemVersion, ProblemLanguage, TestCase, Image + ProblemStatus/BuildStatus/TestCaseVisibility enums
db/models/submission.py Submission, SubmissionResult, JudgeEvent, JudgeOutbox, ProblemScore + SubmissionStatus enum
db/models/instance_settings.py  InstanceSettings (single row id=1, seeded on table creation) + LeaderboardMode enum
routers/<area>.py       APIRouter(prefix="/<area>", tags=["<area>"]); request/response Pydantic models live here
routers/problems.py     /admin/problems (staff, admin): list, editor save, versions, test data and image upload, enable/disable/archive/delete, rebuild
routers/staff.py        /staff (admin): list staff and admins, create (generated or chosen password), edit name, deactivate/reactivate, reset password
routers/images.py       GET /images/{id}: statement images streamed from storage
routers/solve.py        GET /problems, /problems/{slug} (every role): enabled problems, statement, sample cases; staff preview
routers/submissions.py  POST /problems/{slug}/submissions, GET /submissions, /submissions/queue (instance-wide queued count), /submissions/{id}, /submissions/{id}/stream (SSE, the one async route)
routers/logs.py         /admin/logs (admin): the operation log, paged and filtered in SQL (type, user, time range); /admin/logs/types
routers/settings.py     GET /settings: killswitch state, banner message, leaderboard mode; GET /settings/time: server clock for the top bar
routers/internal.py     /internal/* for the judge worker (bearer token): judge-events, judge-jobs/{id}/refresh
worker.py               arq WorkerSettings: start_build, assemble_package jobs + flush_outbox, resume_builds, detect_delayed crons
services/auth.py        current_session / CurrentSession / require_role(...) dependencies + CSRF check
services/session.py     session create/lookup/revoke; Postgres is the source of truth, Redis is a read cache
services/rate_limit.py  Redis rate limits: failed-login counters (per login id, per client IP) and the 10 s submit slot per user
services/errors.py      ApiError: an HTTPException whose body also carries a machine-readable `code`
services/operation_log.py  log_operation / log_operation_now
services/storage.py     boto3 S3 client: put/get/size/stream, presigned URLs; raises StorageError (503 via main.py)
services/packages.py    problem.yaml, staging/final package zips, the three build steps (start, record result, assemble)
services/judge.py       job ids (ULID), Redis stream push, judge_outbox relay
services/jobs.py        enqueue(): hand a job to the arq worker from sync code (best effort)
services/languages.py   LANGUAGES: copy of the judge's language registry
services/submissions.py judge job payload, create_submission, apply_event (judge events), current score, progress pub/sub, detect_delayed
```

Imports are absolute from the backend root (`from db.models.user import User`, `from services.auth import CurrentSession`). There is no package prefix.

## Adding things

- **Endpoint**: add it to `routers/<area>.py` (create the file and `app.include_router(...)` in `main.py`). Take the DB as `db: Db` (`Annotated[DbSession, Depends(get_database)]`) and the caller as `session: CurrentSession`. Restrict roles with `dependencies=[Depends(require_role(UserRole.admin))]`. Write handlers as sync `def`, not `async def`, because the whole stack is sync.
- **Model**: add `db/models/<name>.py` with SQLAlchemy 2.0 typed `Mapped[...]` / `mapped_column(...)`, and **import it in `main.py`** (and `cli.py` if the CLI needs it) so `create_all` sees it. Postgres conventions in use:
  - `BigInteger` ids: `Identity(always=True)` (`GENERATED ALWAYS AS IDENTITY`). `operation_logs` is the only exception and still uses `autoincrement=True` (`BIGSERIAL`)
  - `DateTime(timezone=True)` with `server_default=func.now()`
  - `CITEXT` for case-insensitive identifiers
  - named `CheckConstraint`s (`<table>_<col>_check`)
  - native enums via `Enum(..., name=..., values_callable=...)` so values are stored in lower case
- **Schema changes**: there are **no migrations** (no Alembic). `create_all` only creates missing tables and never alters existing ones. If you change a column on an existing table, say so and tell the user that the dev DB needs a manual `ALTER` or a reset.
- **Setting**: add a typed field to `Settings` with a default if it's optional, document it in `.env.example`, and add a comment for anything non-obvious.

## Invariants: do not break these

- **Sessions**: the cookie holds a random token, and the DB/Redis store only its **SHA-256** (`hash_token`). Never store or log the raw token.
- **Session cache staleness**: Redis caches a snapshot of user fields. After committing a change to a user's `role`, `is_active`, `display_name` or `must_change_password`, call `invalidate_user_sessions(db, user_id)`. Revoking sessions goes through `revoke_session` / `revoke_user_sessions`, which commit and then delete the cache entries.
- **CSRF**: `current_session` rejects non-GET/HEAD/OPTIONS requests without a matching `X-CSRF-Token`. Every state-changing endpoint must depend on `CurrentSession` (or `require_role`). Login is the only unauthenticated POST.
- **Login doesn't leak account existence**: it gives the same 401 message for every failure and runs a dummy argon2 verify for unknown users. Keep both properties.
- **Redis degrades gracefully**: rate limiting fails open, and the session cache falls back to Postgres. The exception is `_cache_delete`, which raises so a revoked session can't stay alive. Wrap new Redis calls in `try/except redis.RedisError` with `logger.warning(..., exc_info=True)`.
- **Operation log**:
  - Use `log_operation(db, "area.action", user_id=..., info={...})` inside the operation's transaction (it flushes, and the caller commits).
  - Use `log_operation_now(...)` for events that must persist even when the request fails (failed logins, permission denials).
  - Type names are dotted snake_case (`auth.login_failed`). Never put passwords or tokens in `info`.
- **Commit order**: commit the DB first, then touch Redis (`cache_session` after `db.commit()`).
- **Single worker**: `main.py` sets up the schema at import time, so the production image runs `--workers 1`. Don't raise it until schema setup moves to a migration step.
- **Versions are immutable**: never change a `ProblemVersion` or its test cases after creation, except `TestCase.hint_md` and the build columns the build steps fill in. A judge-relevant change is a new version (`routers/problems.py` `_same_judging` decides).
- **`current_version_id` moves only in `packages.assemble_package`**, and only forward, so students keep the last good version while a build is pending or failed.
- **Storage order**: upload first, then commit the row; delete the row and leave the file to the orphan sweep. Objects are never overwritten.
- **Background jobs must be resumable**: `enqueue()` may silently fail, so every job needs a database state the `resume_builds` cron can find, and must be safe to run twice (lock the row, return if already done).
- **`/internal/*` never answers 4xx** except 401 and 409: the judge drops an event on any other 4xx and retries on 5xx.
- **Hidden test data never reaches a student**: `routers/submissions.py` shapes every result per viewer (`_result_out`), and `services/submissions.py` refuses to store output for a hidden case. Check both when you add a field to a result or a new way to read one (NFR-SEC-07).
- **Judge events are applied exactly once**: `apply_event` locks the submission, answers 409 for an older attempt or another job id, and dedups on `judge_events.event_id` with `ON CONFLICT DO NOTHING ... RETURNING` (the driver's `rowcount` is -1 here, so never test that).
- **The stream route holds no database connection**: it is `async def`, authenticates in a thread with its own `SessionLocal()`, and must not take `Db` or `CurrentSession` as dependencies.

## Style

- Start modules with `from __future__ import annotations`. Type-annotate everything; use `Optional[...]`/`X | None` for nullable values.
- A module docstring explains the design and shows a short usage example (see `services/*.py`).
- Prefix private helpers with `_`. Put constants in `UPPER_CASE` near the top with a comment giving the reason (`MAX_PASSWORD_LENGTH = 1024  # bound the argon2 work …`).
- Raise errors as `HTTPException(status.HTTP_..., "Sentence-case message")`. The frontend shows `detail` strings to users. When the UI must tell the error apart from others with the same status, raise `ApiError(status.HTTP_..., "Message", code="snake_case")` from `services/errors.py` instead, and list the new code in `docs/srs.md` section 6.1.
- Use `logging.getLogger(__name__)`, not `print` (except in `cli.py`, which prints and uses `sys.exit("error: …")`).
- Keep the sync style throughout: `db.scalar(select(...))`, `db.execute(update(...))`, `db.get(Model, id)`.
- `# type: ignore` is used sparingly to silence Pylance (e.g. `Settings()` in `config.py`). Don't spread it.

## Known gaps

- `GET /healthz` (in `main.py`) is the liveness probe used by the production `HEALTHCHECK`. It doesn't check Postgres or Redis. Keep the route and the Dockerfile in sync, because the prod frontend waits for the backend to be `service_healthy`.
- There are no tests (deferred until after the MVP, see `docs/backend.md`).
- Migrations (Alembic) are also deferred.
- Settings: only `GET /settings` exists. Nothing changes the killswitch or the leaderboard mode yet, so until `/admin/settings` is built the `instance_settings` row is edited in the database.
- Submissions: staff cannot requeue a delayed one or resolve a `review` (JE) one yet; the staff list (`/admin/submissions`), progress, leaderboard and exports are not built.
- Problems: rejudge (FR-PRB-16) and SVG images (FR-PRB-06, needs a sanitiser) are not built.
- A build that the judge never reports stays `pending`; staff cannot rebuild while it is pending.
