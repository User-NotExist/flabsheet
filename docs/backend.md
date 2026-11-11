# Backend implementation

The backend is one FastAPI codebase run as two processes, the HTTP API and a background worker; it is the only component that reads or writes PostgreSQL, and the only one the judge talks to.

Only auth, sessions, the operation log and the database models exist today. Everything else on this page is the plan for the remaining modules. [backend/AGENTS.md](../backend/AGENTS.md) holds the day-to-day coding rules.

## Stack and project layout

The stack is sync: handlers are plain `def` functions that FastAPI runs in its thread pool. The one exception is the SSE stream route, which is `async def` and uses `redis.asyncio`, so that open streams do not each hold a thread.

| Concern | Choice |
| --- | --- |
| Runtime | Python 3.12, FastAPI, Uvicorn, one worker process (see Database) |
| Database | SQLAlchemy 2 (sync) + psycopg 3. `main.py` creates missing tables and indexes at import with `create_all`; Alembic migrations are deferred until after the MVP (NFR-OPS-04) |
| Validation | Pydantic v2; separate response models per role (student vs staff) |
| Redis | `redis-py` (sync) for streams, rate limits and caches; `redis.asyncio` only in the SSE route for pub/sub |
| Object storage | S3 API, path-style, for upload and presigned GET/PUT. `aioboto3` is the dependency today; to be confirmed when the first storage code is written, because the sync handlers need a sync client |
| Passwords | `argon2-cffi` (argon2id) |
| Background jobs | arq (Redis-backed) in a separate `worker` process, same codebase; to be confirmed with the first job, because arq jobs are coroutines and the services are sync |
| Live updates | Server-Sent Events via `sse-starlette` |
| Metrics | `prometheus-fastapi-instrumentator` at `/metrics`, plus `/healthz` (exists) |
| Tests | Deferred until after the MVP. Planned: pytest + httpx; Testcontainers (PostgreSQL, Redis, RustFS) |

The code is flat under `backend/`, with no package prefix. Files marked *planned* do not exist yet:

```
main.py                 FastAPI app, CORS, schema setup, routers, ApiError handler
config.py               settings from env / backend/.env
cli.py                  seed-admin; planned: sync-languages
db/postgres.py          engine, SessionLocal, Base, get_database()
db/redis.py             shared redis client
db/models/              user, operation_log, student_import, problem, submission, instance_settings
routers/<area>.py       one APIRouter per area, with its request/response models
  auth.py               login, logout, logout-all, me, change-password
  planned: staff.py, students.py, problems.py, submissions.py, monitoring.py,
           leaderboard.py, settings.py, images.py, internal.py (judge endpoints)
services/<area>.py      logic shared by routers and background jobs
  auth.py               current_session, require_role, CSRF check
  session.py            session create / lookup / revoke, Redis cache
  rate_limit.py         failed-login counters
  operation_log.py      log_operation, log_operation_now
  errors.py             ApiError (detail + code)
  planned: packages.py, judge.py, scoring.py, storage.py
worker.py               planned: background job entry point
```

## Modules

Each area owns its tables and its routes; endpoints are listed in SRS section 6.1.

| Area | Owns | Implementation notes | Covers |
| --- | --- | --- | --- |
| `auth` | `sessions`, login rate limits | Opaque session token in an HTTP-only Secure SameSite=Lax cookie; only its SHA-256 is stored, in PostgreSQL with a Redis read cache. Sessions expire 7 days after login; there is no idle timeout. Revoke on logout, password change and reset. `require_role(...)` dependency on every router. CSRF: a per-session token returned by login and `GET /auth/me`, sent back in `X-CSRF-Token` on every state-changing request. Generic login error; failed logins counted per account and separately per IP, 10 / 15 min each | FR-AUTH-01–10 |
| `users` | `users`, `student_imports` | Login ID trimmed, case-insensitive (citext), `[A-Za-z0-9._-]{1,64}`. Generated passwords: 12+ chars from `secrets`. CSV import: parse UTF-8 (strip BOM), validate every row, then create all in one transaction or none; return the password CSV in the response only. Last-admin guard on deactivation. No endpoint changes a role | FR-ADM-01–04, FR-STU-01–06 |
| `problems` | `problems`, `problem_versions`, `problem_languages`, `test_cases`, `images` | Title, statement and hint edits change rows in place. Changes to max points, solution, tests, limits, languages, visibility or checking mode create a new version and trigger a build. `current_version_id` moves only when a build succeeds, so an enabled problem keeps its previous version during a rebuild or after a failed one. Enable only when the problem has a current version. Image upload: sniff MIME, sanitize SVG, 5 MB cap; images are streamed back by `GET /images/{id}` with `Content-Security-Policy: sandbox`. Delete only without student submissions (staff test submissions and their scores are deleted first, in the same transaction), else archive | FR-PRB-01–17 |
| `packages` | Package zips in RustFS | Build `problem.yaml` from the version (batch, per-language `time_ms`, `checker.strict`, floats, testcases with `sample: true` for visible and sample cases, one `sum` subtask worth the version's max points). Zip deterministically (sorted entries, fixed timestamps) so the SHA-256 is stable | 6.3 |
| `submissions` | `submissions`, `submission_results` | Submit checks in order: killswitch, problem enabled, language allowed, 64 KB, rate limit, ≤ 3 queued. Student serializer drops hidden-case output, expected output and every checker message on a hidden case (PE included); shows hints only on failed cases. Staff see checker messages for hidden cases but no output: the judge never sends it | FR-STD-05–09, FR-ADM-05, FR-MON-02 |
| `judge` | `judge_events`, `judge_outbox`, Redis streams | Enqueue, events endpoint, refresh endpoint (next section) | FR-JDG-01–05, 6.2–6.5 |
| `scoring` | `problem_scores`, leaderboard cache, exports | Update the current score inside the `done` transaction. Leaderboard: one SQL query over `problem_scores` for active students and enabled problems, cached 5 s; frozen mode serves a snapshot taken at freeze time. CSV exports stream rows, UTF-8 with BOM | FR-JDG-06, FR-STD-02/03, FR-MON-01, 04, 05, 07 |
| `settings` | `instance_settings` | Single row, cached in Redis; changes write the operation log | FR-ADM-05, FR-MON-07 |
| `operation_log` | `operation_logs` | The audit log. `log_operation(db, "area.action", user_id=..., info={...})` inside the operation's transaction; `log_operation_now(...)` for events that must survive a failed request (failed logins, permission denials). Never passwords or tokens in `info` | NFR-SEC-09 |

**Errors.** Raise `HTTPException(status, "Sentence for the user.")`. When the frontend has to react to the kind of error, raise `ApiError(status, "Sentence.", code="snake_case")` from `services/errors.py` instead; the body is then `{"detail": ..., "code": ...}`. Codes in use or reserved: `rate_limited` (in use), `submissions_closed`, `language_not_allowed`, `problem_disabled`, `csv_invalid`.

## Judge integration rules

The judge contract is fixed by judge-worker-go; these rules keep the backend correct when events repeat, arrive late or the API is briefly down.

**Submit (SRS 6.2)**

1. Upload the source to RustFS first, then in one PostgreSQL transaction insert the submission (`queued`, `attempt = 1`, ULID `job_id`) and an outbox row.
2. After commit, `MULTI` → `XADD judge:practice:{course_id}` + `SADD judge:streams:practice` → `EXEC`, then mark the outbox row sent. If Redis fails, the submission stays `queued` and the outbox job retries; the submission never stays without a job (FR-JDG-01). `delayed` is set only by `detect_delayed`.
3. Job JSON is built by one function also used by the refresh endpoint, so both always match: 30-minute presigned GET URLs, `limits` resolved for the language, `feedback.preview_samples: true`.

**Events (`POST /internal/judge-events`, SRS 6.4)**

- Accept one object or an array of up to 50; process each in its own transaction, in order.
- `INSERT INTO judge_events ... ON CONFLICT (event_id) DO NOTHING`; if nothing was inserted, it is a duplicate: return 2xx.
- Lock the submission row (`SELECT ... FOR UPDATE`). If the event's `attempt` is lower than the stored one, return `409`. If higher, store the new attempt and clear old per-test rows.
- Never answer 4xx except 401 (bad token) and 409; unknown verdicts are stored and flagged (the worker drops events on other 4xx).
- `started` → status `compiling`; first `test_result` → `running`.
- On `done`: set verdict, `score_milli`, `finished_at`; JE → status `review`; then update `problem_scores` in the same transaction if this is the user's latest submission for the problem with a scoring verdict; publish to `sub:{submission_id}` after commit.
- Store `output_preview` only for sample and visible cases.

**Builds (SRS 6.3)**

- Build job sends one presigned PUT per test case to `answers/{version_id}/{n}.ans` and the reference solution as a presigned GET.
- On `build_done ok`: verify each uploaded answer's SHA-256 against the event, store each answer's `time_ms` in `test_cases.ref_time_ms` and `max_time_ms` in `max_ref_time_ms`, assemble the final zip, upload `packages/{sha256}.zip`, mark the version `ok` and point `problems.current_version_id` at it. On failure: store reason, test case and log, and leave the current version alone.
- Build status is `pending`, `ok` or `failed`. There is no "building" state, because the judge reports a build only once.

**Refresh (`POST /internal/judge-jobs/{job_id}/refresh`)** returns the job rebuilt with fresh URLs and the current attempt, or `404` if the submission is gone or `job_id` is no longer its current job (it was rejudged).

**Rejudge** gives the submission a new ULID `job_id` and the next `attempt`, then enqueues through the outbox like a submit. `job_id` is unique in `submissions` and `judge_outbox`, so it cannot be reused.

## Background jobs

The worker process runs these; each is safe to run twice.

| Job | Trigger | Does |
| --- | --- | --- |
| `flush_outbox` | Every 5 s | Re-sends unsent judge and build jobs to Redis |
| `assemble_package` | `build_done ok` | Builds and uploads the final package zip, marks the version `ok` and makes it current |
| `detect_delayed` | Every minute | Marks submissions with no `done` after 15 min as `delayed` (FR-JDG-05) |
| `rejudge_problem` | Staff action | Enqueues every submission of the problem, each student's latest first so scores update soonest, on the `rejudge` lane with a new `job_id` and attempt; warns over 200 (SRS 6.6) |
| `refresh_leaderboard` | After `done`, debounced 5 s | Rebuilds the cached leaderboard |
| `cleanup_streams` | Every hour | Removes empty judge streams from `judge:streams:{lane}` after 1 h idle |
| `sweep_orphans` | Weekly | Deletes storage objects older than 24 h that no database row references ([data-and-storage.md](data-and-storage.md)) |

## Security, testing and done

- **Secrets** come from environment or `.env` files only, never from the repository (NFR-SEC-08). The worker token, Redis password and RustFS keys are separate values. Accepted exception: `compose.prod.yaml` copies `backend/.env` and `frontend/.env` into the images it builds, so those images stay on the app server and are never pushed.
- **`/internal/*`** routes live on their own router, on the same port as the public API, and require the worker bearer token. The reverse proxy must refuse `/internal/*` from the public internet and pass it only from the judge network (NFR-SEC-06). Check that rule on every deployment: nothing in the backend enforces it.
- **Tests are deferred until after the MVP.** Until then, check role rules and hidden-data rules by hand for each new endpoint. When tests are added, these come first:
  - **Hidden data:** one test per student endpoint asserts no hidden input, expected output, student output or checker message appears (NFR-SEC-07).
  - **Judge contract tests:** replay recorded worker event sequences (AC, WA, PE, CE, TLE, JE, duplicate, out-of-order attempt, spool array) and check the final state.
  - **End-to-end:** a CI job runs the stack from `compose.prod.yaml` plus the judge's dev stack and judges A+B in C++ and Python.

Definition of done for any backend change:

- [ ] Schema changes called out: `create_all` never alters an existing table, so say which manual SQL or database reset is needed
- [ ] Role checks tried by hand for an allowed and a refused role
- [ ] Hand-written types in `frontend/src/lib/api.ts` and the `/api/...` route handler updated to match
- [ ] Operation log written for account, problem and settings changes
