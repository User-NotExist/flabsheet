# AGENTS.md — backend

**Never read `backend/.env`.** Use `.env.example` and `config.py` to see which settings exist. Also read the root [AGENTS.md](../AGENTS.md).

FastAPI service, Python 3.12, managed with **uv**. It uses sync SQLAlchemy 2.x (psycopg 3) on PostgreSQL and sync redis-py. Passwords are hashed with argon2. `aioboto3` is a dependency for RustFS/S3, but nothing uses it yet.

## Commands

```sh
uv sync                                   # install into .venv
uv run fastapi dev main.py                # http://localhost:8000, docs at /docs (needs postgres+redis up)
uv run python cli.py seed-admin           # create the first admin (password from ADMIN_PASSWORD or a prompt)
uv add <pkg>                              # add a dependency (updates pyproject.toml + uv.lock)
uv run python -m compileall -q .          # quick syntax check
```

- There is **no test suite, linter or formatter config yet**. Don't add one unless asked. Match the existing style by hand.
- Under compose, the backend runs in a container (`docker compose -f ../compose.dev.yaml exec backend …`), and `POSTGRES_URL`/`REDIS_URL` are overridden to point at the service names.

## Layout

```
main.py                 app, CORS, schema setup at import (CREATE EXTENSION citext + create_all), routers
config.py               pydantic-settings `Settings`; module-level `settings` singleton
cli.py                  management CLI (argparse subcommands): seed-admin
db/postgres.py          engine, SessionLocal, Base, get_database() dependency
db/redis.py             shared redis_client (decode_responses=True, 2 s timeouts), get_redis()
db/models/user.py       User, Session (login sessions), UserRole enum
db/models/operation_log.py  OperationLog (audit rows)
routers/<area>.py       APIRouter(prefix="/<area>", tags=["<area>"]); request/response Pydantic models live here
services/auth.py        current_session / CurrentSession / require_role(...) dependencies + CSRF check
services/session.py     session create/lookup/revoke; Postgres is the source of truth, Redis is a read cache
services/rate_limit.py  failed-login counters in Redis
services/operation_log.py  log_operation / log_operation_now
```

Imports are absolute from the backend root (`from db.models.user import User`, `from services.auth import CurrentSession`). There is no package prefix.

## Adding things

- **Endpoint**: add it to `routers/<area>.py` (create the file and `app.include_router(...)` in `main.py`). Take the DB as `db: Db` (`Annotated[DbSession, Depends(get_database)]`) and the caller as `session: CurrentSession`. Restrict roles with `dependencies=[Depends(require_role(UserRole.admin))]`. Write handlers as sync `def`, not `async def`, because the whole stack is sync.
- **Model**: add `db/models/<name>.py` with SQLAlchemy 2.0 typed `Mapped[...]` / `mapped_column(...)`, and **import it in `main.py`** (and `cli.py` if the CLI needs it) so `create_all` sees it. Postgres conventions in use:
  - `BigInteger` ids: `Identity(always=True)` for users, `autoincrement=True` elsewhere
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

## Style

- Start modules with `from __future__ import annotations`. Type-annotate everything; use `Optional[...]`/`X | None` for nullable values.
- A module docstring explains the design and shows a short usage example (see `services/*.py`).
- Prefix private helpers with `_`. Put constants in `UPPER_CASE` near the top with a comment giving the reason (`MAX_PASSWORD_LENGTH = 1024  # bound the argon2 work …`).
- Raise errors as `HTTPException(status.HTTP_..., "Sentence-case message")`. The frontend shows `detail` strings to users.
- Use `logging.getLogger(__name__)`, not `print` (except in `cli.py`, which prints and uses `sys.exit("error: …")`).
- Keep the sync style throughout: `db.scalar(select(...))`, `db.execute(update(...))`, `db.get(Model, id)`.
- `# type: ignore` is used sparingly to silence Pylance (e.g. `Settings()` in `config.py`). Don't spread it.

## Known gaps

- `GET /healthz` (in `main.py`) is the liveness probe used by the production `HEALTHCHECK`. It doesn't check Postgres or Redis. Keep the route and the Dockerfile in sync, because the prod frontend waits for the backend to be `service_healthy`.
- Nothing uses RustFS/S3 yet, and there are no tests.
