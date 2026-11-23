# Flabsheet

A programming-course platform for students, staff and admins: problems, submissions, progress and a leaderboard.

Presentation Video: https://youtu.be/HAY-yqmbNzo

```
browser ──► frontend (Next.js :3000) ──/api/*──► backend (FastAPI :8000) ──► PostgreSQL, MongoDB
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

Replace every `change-me` value. You can generate secrets with `openssl rand -hex 24`. Under Compose, the database, MongoDB, Redis and S3 addresses and keys in `backend/.env` are overridden from the root `.env`, so the passwords only need to be set once.

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

Start only the data services (PostgreSQL, MongoDB, Redis, RustFS), then run the apps directly. In this mode the `localhost` URLs in `backend/.env` are used, so their passwords must match the root `.env`.

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

`compose.prod.yaml` runs PostgreSQL, MongoDB, Redis, RustFS, the backend, the worker and the frontend on the app server. The judge runs on separate, dedicated hosts.

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

Serve the frontend (`127.0.0.1:3000`) over TLS. The backend (`127.0.0.1:8000`) only needs to be reachable by judge hosts, for `/internal/*`. The proxy must **refuse `/internal/*` from the public internet** and pass it only from the judge network. Don't expose RustFS, PostgreSQL or MongoDB publicly.

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

Upgrading from a version without MongoDB: set `MONGO_ROOT_PASSWORD` in `.env` first, then after the update copy the old log and results, check them, and drop the old Postgres data (see `docs/data-and-storage.md`):

```sh
docker compose -f compose.prod.yaml exec backend python cli.py migrate-to-mongo
docker compose -f compose.prod.yaml exec backend python cli.py migrate-to-mongo --drop-old
```

## CRUD coverage

Which part of the web UI creates, reads, updates and deletes each table (PostgreSQL) and collection (MongoDB). "System" means the backend, the worker or the judge writes it as a side effect, and no page edits it directly. Where a delete is really a deactivation, an archive or an expiry, the table says so.

| Entity | Engine | Create | Read | Update | Delete | Where in the UI |
| --- | --- | --- | --- | --- | --- | --- |
| `users` (students) | PostgreSQL | Add one, or import a CSV | List and search | Display name, reset password, reactivate | **Deactivate** (the row stays: submissions and scores refer to it) | `/manage/students` |
| `users` (staff, admin) | PostgreSQL | Add staff (admins come from `cli.py seed-admin`) | List and search | Display name, reset password, reactivate | **Deactivate** (the last active admin cannot be) | `/admin/staff` |
| `sessions` | PostgreSQL | Sign in | System (every request checks it; no list page) | System (`last_seen_at`) | Log out; a password change or reset revokes the others | `/login`, account menu, `/change-password` |
| `student_imports` | PostgreSQL | CSV import | — (audit row; the result CSV is downloaded once) | — | — | `/manage/students` |
| `problems` | PostgreSQL | New problem | Problem lists, problem page | Editor (title, statement), enable / disable | Delete while no student has submitted, else **archive** (read-only, hidden from students) | `/manage/problems`, `/manage/problems/[id]`, `/problems` |
| `problem_versions` | PostgreSQL | Saving a judge-relevant change in the editor | Editor, build panel | — (**immutable**; only the build fills in its result) | With its problem | `/manage/problems/[id]` |
| `problem_languages` | PostgreSQL | Editor settings (part of a new version) | Editor, problem page limits | — (immutable, part of the version) | With its version | `/manage/problems/[id]`, `/problems/[slug]` |
| `test_cases` | PostgreSQL | Editor test cases (part of a new version) | Editor; students see samples | Hint in place; anything else makes a new version | Removing a case makes a new version without it; rows go with the problem | `/manage/problems/[id]`, `/problems/[slug]` |
| `images` | PostgreSQL + RustFS | Upload in the statement editor | Rendered in statements | — (files are never overwritten) | **Orphan sweep** removes images no statement or hint links, 24 h after | `/manage/problems/[id]` |
| `submissions` | PostgreSQL | Submit | History, result page, staff browser, CSV | Rejudge, requeue (staff); status and verdict by the judge | — (staff test submissions go with their problem) | `/problems/[slug]`, `/submissions/[id]`, `/manage/submissions` |
| `problem_scores` | PostgreSQL | System (first judged result) | Problem list, progress matrix, leaderboard, scores CSV | System (each judged result, rejudges) | With its problem | `/problems`, `/manage/progress`, `/leaderboard` |
| `judge_events` | PostgreSQL | System (judge) | — | — | — | none: idempotency log |
| `judge_outbox` | PostgreSQL | System | — | System (sent, retries) | — | none: delivery queue |
| `instance_settings` | PostgreSQL | System (one row, seeded) | Banner, settings page | Killswitch, leaderboard mode | — (single row) | `/admin/settings`, `/manage/leaderboard` |
| `operation_logs` | MongoDB | System (every audited action) | Filtered, paged list | — (**append-only** audit log) | — | `/admin/logs` |
| `submission_reports` | MongoDB | System (judge events) | Result report per test | System (each event; a rejudge writes a new attempt) | With its problem | `/submissions/[id]`, `/problems/[slug]` |
| `clarifications` | MongoDB | Ask a question; staff post announcements (on a problem or course-wide); reply | Problem tab, staff queue, dashboard announcements | Edit own question and replies; staff set status, pin, visibility, edit any reply | Own question while unanswered, own replies; staff any thread or reply; with its problem | `/problems/[slug]` (Clarifications tab), `/manage/clarifications`, `/` |
| `notifications` | MongoDB | System (a staff reply, an announcement); staff send one | Bell, full list | Mark read / unread, mark all read | Dismiss, clear read; **expire** after 90 days (TTL index) | top bar bell, `/notifications`, send dialog on `/manage/clarifications` |

## API routes

The browser calls `/api/<path>` on the frontend, and a route handler under `frontend/src/app/api/` forwards it to the backend's `<path>` (`frontend/src/lib/backend.ts`). For example, `POST /api/auth/login` becomes `POST /auth/login`. The full request and response schemas are at http://localhost:8000/docs in development.

- **Sessions**: the backend sets an HttpOnly session cookie at login. Every `POST`, `PUT`, `PATCH` and `DELETE` must also send the session's CSRF token in `X-CSRF-Token`. The token comes from `POST /auth/login` and `GET /auth/me`. A missing or wrong token gets `403`.
- **Errors** are `{"detail": "...", "code": "..."}`, where `code` is optional. The codes are listed in `docs/srs.md` section 6.1.

The **Access** column uses these levels:

| Access | Who may call it |
| --- | --- |
| Public | Anyone, without a session |
| Account | Any signed-in user, including one who still has to change an issued password |
| Signed in | Any role, once the password has been changed (otherwise `403 Change your password to continue`) |
| Staff | Staff and admins |
| Admin | Admins only |
| Judge | Judge workers, with `Authorization: Bearer <JUDGE_API_TOKEN>`. Not forwarded by the frontend. |

Routes marked "Signed in" that serve both roles return different data to staff and students, as noted in the table.

### Auth (`routers/auth.py`)

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/auth/login` | Public | Sign in with login ID and password. Sets the session cookie and returns the user and CSRF token. Rate-limited per login ID and IP. |
| GET | `/auth/me` | Account | The current user and CSRF token |
| POST | `/auth/logout` | Account | End this session |
| POST | `/auth/logout-all` | Account | End every session of this user. Backend only: the frontend has no route for it. |
| POST | `/auth/change-password` | Account | Set a new password and sign out the other sessions. The current password isn't needed while the account is flagged to change it. |

### Accounts (`routers/students.py`, `routers/staff.py`)

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/students` | Staff | List students |
| POST | `/students` | Staff | Create one student. Returns the generated password once. |
| PATCH | `/students/{user_id}` | Staff | Change display name, deactivate or reactivate. Deactivating revokes the student's sessions. |
| POST | `/students/{user_id}/reset-password` | Staff | Issue a new password, which the student must change at next sign-in |
| POST | `/students/import` | Staff | Import a CSV (`display_name,student_id`). All or nothing. Returns a CSV of the generated passwords. |
| GET | `/staff` | Admin | List staff and admins |
| POST | `/staff` | Admin | Create a staff account |
| PATCH | `/staff/{user_id}` | Admin | Change display name, deactivate or reactivate. The last active admin can't be deactivated. |
| POST | `/staff/{user_id}/reset-password` | Admin | Issue a new password |

### Problem management (`routers/problems.py`)

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/admin/languages` | Staff | Languages a problem may allow |
| GET | `/admin/problems` | Staff | Every problem with its status and build state |
| POST | `/admin/problems` | Staff | Create an empty draft |
| GET | `/admin/problems/{problem_id}` | Staff | The problem for the editor |
| PATCH | `/admin/problems/{problem_id}` | Staff | Save the editor. A new version and build start only when something that affects judging changed. |
| DELETE | `/admin/problems/{problem_id}` | Staff | Delete a problem nobody has submitted to (otherwise archive it) |
| POST | `/admin/problems/{problem_id}/enable` | Staff | Show it to students |
| POST | `/admin/problems/{problem_id}/disable` | Staff | Hide it from students |
| POST | `/admin/problems/{problem_id}/archive` | Staff | Disable for good, read-only |
| GET | `/admin/problems/{problem_id}/build` | Staff | Build state, cheap enough to poll |
| POST | `/admin/problems/{problem_id}/build` | Staff | Build the newest version again, as a new version |
| POST | `/admin/problems/{problem_id}/rejudge` | Staff | Judge all the problem's submissions again on its current version |
| POST | `/admin/problems/{problem_id}/testdata` | Staff | Upload one test input. Returns the hash that a later save refers to. |
| POST | `/admin/problems/{problem_id}/images` | Staff | Upload a statement image, linked as `/api/images/{id}` |

### Solving and submissions (`routers/solve.py`, `routers/images.py`, `routers/submissions.py`)

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/problems` | Signed in | Enabled problems with the caller's own score and status |
| GET | `/problems/{slug}` | Signed in | Statement, limits, languages and sample cases. Staff can also open problems that aren't enabled (preview) and get the reference solution. Students get `404` for those. |
| GET | `/images/{image_id}` | Signed in | A statement image. Students get `404` for images of problems that aren't enabled. |
| POST | `/problems/{slug}/submissions` | Signed in | Submit a solution. Checks the killswitch and the rate limits (one per 10 s, at most 3 being judged). Staff submissions are test submissions. |
| GET | `/submissions` | Signed in | The caller's own submissions, optionally for one problem |
| GET | `/submissions/queue` | Signed in | How many submissions from everyone the judge hasn't started yet |
| GET | `/submissions/{submission_id}` | Signed in | One submission and its report. Students only see their own. Staff also see hidden test data and checker messages. |
| GET | `/submissions/{submission_id}/stream` | Signed in | Server-sent events with live progress until the result is final. The route checks the session cookie itself. |

### Staff views and exports (`routers/admin_submissions.py`, `routers/progress.py`)

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/admin/submissions` | Staff | All submissions, filtered by student, problem, verdict and date |
| POST | `/admin/submissions/{submission_id}/rejudge` | Staff | Judge a finished submission again |
| POST | `/admin/submissions/{submission_id}/requeue` | Staff | Send a delayed submission to the judge again |
| GET | `/admin/export/submissions.csv` | Staff | Raw submissions CSV, with the same filters as the list |
| GET | `/admin/progress` | Staff | Progress matrix: every student × problem |
| GET | `/admin/export/scores.csv` | Staff | One row per active student with a score column per problem |

### Settings and leaderboard (`routers/settings.py`, `routers/leaderboard.py`)

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/settings` | Signed in | Whether submissions are open (with the banner message while closed), the leaderboard mode, and when it was frozen |
| GET | `/settings/time` | Signed in | Server time and UTC offset, for the clock in the top bar |
| PUT | `/admin/settings/submissions` | Admin | Submission killswitch (`submissions_open`) |
| PUT | `/admin/settings/leaderboard` | Staff | Leaderboard mode: live, hidden or frozen |
| GET | `/leaderboard` | Signed in | Standings. Staff always get live standings. Students get the mode staff chose: hidden returns `403` with code `leaderboard_hidden`. |

### Clarifications (`routers/clarifications.py`)

The UI shows thread controls from each thread's `permissions` field, which the backend computes.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/clarifications` | Signed in | Staff get the queue of every thread. Students get their own questions. |
| POST | `/clarifications` | Staff | Post a course-wide announcement and notify every active student |
| GET | `/clarifications/announcements` | Signed in | Course-wide announcements, pinned first, for the dashboard |
| GET | `/clarifications/{clarification_id}` | Signed in | One thread with its replies |
| PATCH | `/clarifications/{clarification_id}` | Signed in | Students edit their own question. Staff also set status, pin and visibility. |
| DELETE | `/clarifications/{clarification_id}` | Signed in | Students delete their own question while it has no replies. Staff delete any thread. |
| POST | `/clarifications/{clarification_id}/replies` | Signed in | Reply. A staff reply answers the question and notifies its author. |
| PATCH | `/clarifications/{clarification_id}/replies/{reply_id}` | Signed in | Edit a reply: your own on a private thread, or any as staff |
| DELETE | `/clarifications/{clarification_id}/replies/{reply_id}` | Signed in | Delete a reply: your own, or any as staff |
| GET | `/problems/{slug}/clarifications` | Signed in | Threads on one problem that the caller may read |
| POST | `/problems/{slug}/clarifications` | Signed in | Ask a question about a problem, or (staff) post an announcement on it |

### Notifications (`routers/notifications.py`)

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/notifications` | Signed in | The caller's notifications, paged |
| GET | `/notifications/unread-count` | Signed in | Unread count for the bell |
| POST | `/notifications/read-all` | Signed in | Mark everything read |
| DELETE | `/notifications` | Signed in | Remove every notification already read (requires `read=true`) |
| PATCH | `/notifications/{notification_id}` | Signed in | Mark one notification read or unread |
| DELETE | `/notifications/{notification_id}` | Signed in | Dismiss one notification |
| POST | `/admin/notifications` | Staff | Send a message to one active student or to all of them |

### Operation log (`routers/logs.py`)

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/admin/logs` | Admin | Audit log entries, filtered and paged |
| GET | `/admin/logs/types` | Admin | The entry types, for the filter |

### Judge and health (`routers/internal.py`, `main.py`)

These aren't forwarded by the frontend. In production, the reverse proxy must allow `/internal/*` only from the judge network (see [Reverse proxy](#3-reverse-proxy)).

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/internal/judge-events` | Judge | One judge event, or up to 50 when the worker replays its spool. Idempotent by event ID. |
| POST | `/internal/judge-jobs/{job_id}/refresh` | Judge | The same job with fresh presigned URLs, for a job a worker reclaimed late |
| GET | `/healthz` | Public | Liveness probe for the Docker health check. Doesn't touch the databases. |

## More documentation

- `docs/srs.md`: requirements and resolved decisions
- `docs/data-and-storage.md`, `docs/backend.md`, `docs/frontend.md`: design and implementation plans
- `backend/AGENTS.md`, `frontend/AGENTS.md`: developer notes for each part
