# Flabsheet

A programming-course platform for students, staff and admins: problems, submissions, progress and a leaderboard.

```
browser ──► frontend (Next.js :3000) ──/api/*──► backend (FastAPI :8000) ──► PostgreSQL
                                                   worker (arq)          ──► Redis, RustFS (S3)
judge-worker-go ◄── Redis Streams / RustFS ──► backend /internal/* (events)
```

The browser only talks to the frontend. The frontend forwards `/api/*` to the backend, which authenticates every request.

## Requirements

- Docker with Compose v2
- For the judge: Linux ≥ 5.19 with cgroup v2 (go-judge runs as a privileged container)
- Only to run the backend or frontend outside Docker: [uv](https://docs.astral.sh/uv/) 0.12.15 and [bun](https://bun.sh) 1.3.14

## Configuration

There are three env files. Each has an example file listing every setting with its default:

| File | Template | Used for |
| --- | --- | --- |
| `.env` | `env.example` | Infra passwords, ports, bind addresses, Docker subnet |
| `backend/.env` | `backend/.env.example` | API settings (sessions, rate limits, S3, judge token) |
| `frontend/.env` | `frontend/.env.example` | Next.js server settings (backend URL, cookie name) |

```sh
cp env.example .env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Replace every `change-me` value. You can generate secrets with `openssl rand -hex 24`. Under Compose, the database, Redis and S3 addresses and keys in `backend/.env` are overridden from the root `.env`, so the passwords only need to be set once.

## Development

Backend and frontend source is bind-mounted, so changes hot-reload.

```sh
docker compose -f compose.dev.yaml up --build
docker compose -f compose.dev.yaml exec backend python cli.py seed-admin   # first admin (prompts for a password)
```

- Frontend: http://localhost:3000
- Backend API docs: http://localhost:8000/docs
- RustFS console: http://localhost:9001

The storage buckets (`assets`, `problems`) are created automatically by the one-shot `storage-init` service.

Logs:

```sh
docker compose -f compose.dev.yaml logs -f backend worker frontend
```

After changing dependencies (`pyproject.toml`/`uv.lock` or `package.json`/`bun.lock`), restart with `--build`.

### Demo students

With the development stack running, run this command from the repository root:

```sh
docker compose -f compose.dev.yaml exec backend python cli.py seed-students
```

Sign in as staff or admin and open **Students** (`/manage/students`). The seed adds logins
`6512345` through `6512351` from the page mockup. Six are active and `6512350` starts
deactivated. The command prints a generated password once for each new login. Students
must change it at first sign-in. Running the command again skips every existing login,
including accounts whose name, role, status or password has changed.

Each student is a row in `users` with `role=student`. The student ID is the case-insensitive
`login_id`. PostgreSQL generates the separate numeric primary key `id`. The CLI records
`created_by=NULL` for these system-created accounts. Accounts created from the page
record the staff or admin user's primary key in `created_by`.

### With the judge

The judge (go-judge sandbox and judge-worker) is built from the `judge-worker-go` git submodule. It lives in a separate overlay file, so the app also runs without it. Without the judge, package builds and submissions stay queued.

```sh
git submodule update --init judge-worker-go
docker compose -f compose.dev.yaml -f compose.dev.judge.yaml up --build
```

To include the judge by default, add this to the root `.env`:

```sh
COMPOSE_FILE=compose.dev.yaml:compose.dev.judge.yaml
```

The judge-worker is compiled Go, so it has no hot reload. Rebuild it after changing the submodule:

```sh
docker compose -f compose.dev.yaml -f compose.dev.judge.yaml up -d --build judge-worker
```

### Running the backend or frontend on the host

Start only the data services (PostgreSQL, Redis, RustFS), then run the apps directly. In this mode the `localhost` URLs in `backend/.env` are used, so their passwords must match the root `.env`.

```sh
docker compose -f infra/compose.yaml --env-file .env up -d

cd backend
uv sync
uv run fastapi dev main.py              # http://localhost:8000
uv run arq worker.WorkerSettings        # background worker, in another terminal
uv run python cli.py seed-admin

cd frontend
bun install
bun run dev                             # http://localhost:3000
```

### Resetting

`docker compose -f compose.dev.yaml down` stops the stack and keeps the data. Adding `-v` also **deletes the database and storage volumes**.

## Production

`compose.prod.yaml` runs PostgreSQL, Redis, RustFS, the backend, the worker and the frontend on the app server. The judge runs on separate, dedicated hosts.

### 1. Configure

Create the three env files as described in [Configuration](#configuration) and use real secrets. Settings that matter in production:

- **`.env`**
  - `BIND_ADDR`: the app server's private IP, so judge hosts can reach Redis and RustFS. Allow only the judge network in the firewall.
  - `APP_BIND_ADDR`: keep `127.0.0.1` and put a reverse proxy in front.
- **`backend/.env`**
  - `FRONTEND_URL`: the public `https://` URL. This also makes the session cookie `Secure`.
  - `JUDGE_API_TOKEN`: the token judge workers send. While it is empty, judge events are refused.
  - `S3_PUBLIC_ENDPOINT_URL`: the RustFS address the judge hosts use, for example `http://10.0.0.5:9000`. Presigned URLs are signed for this host.

`backend/.env` and `frontend/.env` are **copied into the images at build time**. Rebuild after changing them, and never push these images to a registry.

### 2. Start

```sh
docker compose -f compose.prod.yaml up -d --build
docker compose -f compose.prod.yaml exec backend python cli.py seed-admin
docker compose -f compose.prod.yaml ps     # backend healthy, storage-init exited 0
```

The backend creates the database schema at startup, and `storage-init` creates the buckets. You can re-run it safely with `docker compose -f compose.prod.yaml run --rm storage-init`.

### 3. Reverse proxy

Serve the frontend (`127.0.0.1:3000`) over TLS. The backend (`127.0.0.1:8000`) only needs to be reachable by judge hosts, for `/internal/*`. The proxy must **refuse `/internal/*` from the public internet** and pass it only from the judge network. Don't expose RustFS or PostgreSQL publicly.

### 4. Judge hosts

Each judge host runs the go-judge and judge-worker pair from the judge repository. Follow `judge-worker-go/README.md` (deployment files in `judge-worker-go/deploy/opt-judge/`). Give each host:

- a unique worker id
- the Redis password and RustFS keys from the root `.env`
- an API token equal to the backend's `JUDGE_API_TOKEN`
- the API, Redis and RustFS addresses on the app server's private network

### Updating

```sh
git pull
docker compose -f compose.prod.yaml up -d --build
```

## More documentation

- `docs/srs.md`: requirements and resolved decisions
- `docs/data-and-storage.md`, `docs/backend.md`, `docs/frontend.md`: design and implementation plans
- `backend/AGENTS.md`, `frontend/AGENTS.md`: developer notes for each part
