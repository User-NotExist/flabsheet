# AGENTS.md

**DO NOT READ .ENV CONTENT.** Never open, print, grep, `cat`, `source` or copy any `.env` file (`./.env`, `backend/.env`, `frontend/.env`). To learn which settings exist, read the matching `env.example` / `.env.example`, `backend/config.py` or the compose files instead.

Guidance for AI coding agents working in this repo. Each part has its own file, so read it before changing code there:

- [backend/AGENTS.md](backend/AGENTS.md): FastAPI + SQLAlchemy + Redis API
- [frontend/AGENTS.md](frontend/AGENTS.md): Next.js 16 app (App Router, shadcn/ui on Base UI)
- [judge-worker-go/CLAUDE.md](judge-worker-go/CLAUDE.md): Go judge worker (**git submodule**, separate repo)

The design lives in [docs/](docs/): `srs.md` (requirements and resolved decisions), `data-and-storage.md` (schema, buckets), `backend.md` and `frontend.md` (implementation plans). Most of it is not built yet. When code and docs disagree, say so and ask instead of picking one.

The page design lives in [docs/img/](docs/img/): file name shows the page title and slug. Use it as a guide/reference to build the frontend.

## What this is

Flabsheet is a programming-course platform for students, staff and admins: problems, submissions, progress and a leaderboard. The current code covers auth (login, sessions, change password, role-gated navigation), an audit/operation log and problem management for staff (`/manage/problems`: list, editor, package builds through the judge). The other nav pages (`/problems`, `/manage/students`, …) do not exist yet.

```
browser ──► frontend (Next.js :3000) ──/api/* route handlers──► backend (FastAPI :8000) ──► PostgreSQL
                │  src/proxy.ts: page auth gate (GET /auth/me)                      └────► Redis (sessions cache, rate limits)
                                                                                            RustFS (S3: buckets "assets", "problems")
                                                  worker (arq, same backend code) ──► PostgreSQL, Redis, RustFS
judge-worker-go ◄── Redis Streams / RustFS (separate hosts in production) ──► backend /internal/* (events)
```

- The browser **only** talks to the frontend. The frontend server forwards `/api/*` to the backend (`frontend/src/lib/backend.ts`).
- The backend is the security boundary: it authenticates and authorizes every request (session cookie + `X-CSRF-Token`). The frontend's role checks only shape the UI.

## Layout

```
backend/            FastAPI service + background worker (uv, Python 3.12)
frontend/           Next.js app (bun)
infra/compose.yaml  postgres 16.4, redis 7.4.1, rustfs 1.0.2, storage-init (creates buckets)
compose.dev.yaml    infra + backend/worker/frontend with hot reload (source bind-mounted) + go-judge/judge-worker (built from the submodule)
compose.prod.yaml   infra + production images (.env files baked in at build time)
env.example         template for the root .env (infra passwords, ports, subnet)
docs/               SRS and implementation plans
judge-worker-go/    submodule: git@github.com:User-NotExist/judge-worker-go.git
```

## Commands

```sh
# Full dev stack (frontend http://localhost:3000, backend http://localhost:8000/docs)
docker compose -f compose.dev.yaml up --build
docker compose -f compose.dev.yaml exec backend python cli.py seed-admin   # first admin
docker compose -f compose.dev.yaml logs -f backend worker frontend

# Only the data services, to run backend/frontend on the host
docker compose -f infra/compose.yaml --env-file .env up -d
```

- Rebuild with `--build` after changing dependencies (`pyproject.toml`/`uv.lock`, `package.json`/`bun.lock`). Source changes hot-reload.
- Production: `compose.prod.yaml` copies `backend/.env` and `frontend/.env` into the images. Never push those images to a registry.
- The user's shell is **zsh**: quote globs (`find . -name '*.py'`).

## Cross-cutting contracts (change both sides together)

- **Session cookie name**: backend `SESSION_COOKIE_NAME` must equal frontend `SESSION_COOKIE_NAME` (default `flabsheet_session`).
- **Password rule**: `MIN_PASSWORD_LENGTH = 8` lives in `backend/cli.py`, `backend/routers/auth.py` and `frontend/src/lib/api.ts`.
- **Login id rule**: `^[A-Za-z0-9._-]{1,64}$` appears in `backend/db/models/user.py` (DB check), `backend/routers/auth.py`, `backend/cli.py`, plus `maxLength={64}` in the login form.
- **Roles**: `student | staff | admin`, defined by `UserRole` (backend) and the `UserRole` type (frontend `lib/api.ts`).
- **API shapes**: `AuthResponse`/`UserOut` in `backend/routers/auth.py` mirror the `User`/`AuthResponse` types in `frontend/src/lib/api.ts`. The frontend types are written by hand, and JSON fields are snake_case on both sides.
- **Error codes**: errors are `{detail}` plus an optional `code` (backend `services/errors.py` `ApiError`, frontend `ApiError.code`). The frontend branches on codes, so never rename one. The list is in `docs/srs.md` section 6.1.
- **Judge contract**: job, package and event formats are defined by `judge-worker-go/README.md`. The backend adapts to it; contract changes are additive and made in the judge repo first.
- **Languages**: `backend/services/languages.py` is a copy of the judge's `languages.yaml` (ids and `source_name`). Add a language in the judge first, then there.
- **Judge token and storage address**: the judge's api token equals backend `JUDGE_API_TOKEN`, and `S3_PUBLIC_ENDPOINT_URL` must be the RustFS address the judge host uses, because presigned URLs are signed for that host.
- **Problem limits**: slug rule `^[a-z0-9-]{1,64}$`, 100 test cases, 8 MB per input, 5 MB per image, 1000-character hints and 64 KB sources live in `backend/db/models/` and `backend/routers/problems.py`, and again in `frontend/src/lib/api.ts`.
- **New backend endpoint used by the browser**: also add a route handler under `frontend/src/app/api/...` that calls `forwardToBackend`.
- **Client IP**: the frontend forwards `X-Forwarded-For`, and the backend trusts it only from `STACK_SUBNET` (`FORWARDED_ALLOW_IPS` in the compose files).

## Conventions

- **Commits**: short conventional prefixes, lower case: `feat: …`, `chore: …`, `refact: …`. Don't commit or push unless asked.
- **Comments explain why** (security reasons, invariants, framework quirks), not what. Module docstrings and JSDoc headers show usage. Keep them up to date when you change behaviour.
- **Config**: every new setting goes in the matching `*.example` file with its default and a one-line explanation. Never add real secrets; examples use `change-me`.
- **Pinned versions**: Docker images and tools (uv 0.12.15, bun 1.3.14, postgres, redis, rustfs) are pinned on purpose, and redis/rustfs match the judge worker's dev stack. Don't bump them unless asked.
- **Submodule**: treat `judge-worker-go/` as a separate project with its own rules. Don't edit it from here unless asked, and never commit a submodule pointer change by accident.

## Safety

- Never read `.env` files (see the top of this file).
- Don't run destructive compose commands (`down -v`, volume removal) without asking: they delete the dev database.
- Changes to `compose.prod.yaml`, the Dockerfiles or `infra/compose.yaml` affect deployment, so call them out explicitly.
