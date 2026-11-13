# Flabsheet MVP — System Requirements Specification


## 1. Introduction

Flabsheet MVP is a web-based coding judge and grader for one course: staff publish programming problems, students submit code in the browser, and an isolated judge scores every submission automatically.

### 1.1 Purpose

This document specifies what the MVP must do, how its parts fit together, and what each part must guarantee. It is the reference for implementation, testing and acceptance.

### 1.2 Scope

In scope for the MVP:

- Account management with three roles: student, staff, admin
- Problem authoring in Markdown with image upload, reference solutions and test cases
- In-browser code editing, submission and result reporting
- Automatic judging through the existing `judge-worker-go` service
- Progress tracking, a leaderboard staff can hide or freeze, CSV export of results, and an admin killswitch for new submissions

### 1.3 Single-course instance

One deployment serves exactly one course. There is no course switcher, no enrolment step and no multi-tenancy. Every user, problem and submission belongs to that course. The judge queue still carries a `course_id`; the instance uses one fixed value (configured, default `1`).

### 1.4 Definitions

| Term | Meaning |
| --- | --- |
| Instance | One deployment of Flabsheet, serving one course |
| Problem | A task with a Markdown statement, limits, allowed languages, a reference solution and test cases |
| Test case | One input file; its expected output is generated from the reference solution |
| Test case visibility | **Hidden**: only the verdict reaches students. **Visible**: input, expected output and the student's output are shown in results. **Sample**: visible, and also shown on the problem page under the statement. |
| Submission | One student attempt at one problem in one language |
| Current score | A student's score on a problem: the score of their latest submission that finished judging with a scoring verdict (FR-JDG-06). Used by the problem list, leaderboard and exports. |
| Verdict | Judge result code: AC, PA, WA, PE, TLE, MLE, OLE, RE, CE, SE, JE |
| Package | Zip of `problem.yaml` + test data that the judge downloads, identified by SHA-256 |
| Build job | Judge job that runs the reference solution to produce expected outputs |
| Lane | Priority class of a judge job in Redis (`exam`, `homework`, `rejudge`, `practice`, `build`) |

### 1.5 Requirement keywords

**MUST** = required for MVP acceptance. **SHOULD** = expected unless there is a stated reason not to. **MAY** = optional. Requirements carry IDs (for example `FR-STF-04`) so tests and tickets can trace to them.

## 2. Overall description

Three roles share one web app; each role inherits everything the role below it can see except the student-only views.

### 2.1 User roles

| Role | Who | Can do |
| --- | --- | --- |
| Student | Enrolled learners, created by staff | Browse enabled problems, submit code, see own results, see the leaderboard |
| Staff | Instructors and TAs, created by admin | Author and manage problems, create students, view and export all submissions |
| Admin | Course owner / operator, seeded at install | Everything staff can do, plus create and manage staff accounts |

Roles are fixed per account. A user has exactly one role. There is no self-registration, and no web page or API endpoint changes a role. The only exception is the install CLI: `seed-admin --reset-password` turns an existing account into an active admin (FR-AUTH-10).

### 2.2 Operating environment

- Clients: current desktop Chrome, Firefox, Safari and Edge (last 2 major versions). Mobile browsers MUST render problems and results; the code editor is desktop-first.
- Server: Linux hosts running Docker. Judge hosts are dedicated machines meeting the judge-worker requirements (Linux ≥ 5.19, cgroup v2, swap off).
- Network: judge hosts reach only the API, Redis, RustFS, NTP and the image registry.

### 2.3 Design and implementation constraints

| Area | Constraint |
| --- | --- |
| Frontend | Next.js (React) with shadcn/ui components and Tailwind CSS, run on Bun |
| Backend API | FastAPI (Python) |
| Relational DB | PostgreSQL: users, problems, test cases, submissions, results |
| Queue / cache | Redis: judge job streams, sessions/rate limits, live result fan-out |
| Object storage | RustFS (S3-compatible): images, submission sources, problem packages |
| Judge | `judge-worker-go` with go-judge sandbox, kept in its own repository (git submodule) |

The judge worker MUST be treated as an external component: Flabsheet adapts to its job, package and event contracts, not the reverse. When Flabsheet needs something the contract lacks, the change is made in the judge repository first and only by adding fields. So far there is one such addition: `time_ms` on each answer in `build_done` (FR-PRB-13).

### 2.4 Assumptions and dependencies

- One course per instance; course identity is configuration, not data.
- Supported languages are those present in the judge's `languages.yaml` (the MVP launches with only C++20 `cpp20-gcc13` and Python 3.12 `py312`).
- Problems are standard input/output (`batch`) problems with the default token checker in the MVP.
- Staff are trusted to write correct reference solutions; expected outputs are generated from them, never typed by hand.
- Student passwords are distributed by staff out of band (from the returned CSV).

## 3. System architecture

The FastAPI backend is the only component that touches PostgreSQL; the judge host receives work through Redis and reports back over HTTP.

```
Browser ──HTTPS──▶ Next.js frontend (Bun) ──/api/*───▶ FastAPI backend ──▶ PostgreSQL
                                                         ├──▶ RustFS (assets, problems)
                                                         └──XADD──▶ Redis streams
Judge host (dedicated):
  judge-worker ──XREADGROUP──▶ Redis
  judge-worker ──GET packages / presigned sources──▶ RustFS
  judge-worker ──POST /internal/judge-events──▶ FastAPI
  judge-worker ──▶ go-judge sandbox
```
The judge never talks to PostgreSQL; the backend is the only component that does.

The browser reaches the backend through the Next.js app; the judge worker pulls jobs from Redis, fetches packages and sources from RustFS, runs code in go-judge and posts events to the API.

### 3.1 Components

| Component | Technology | Responsibility |
| --- | --- | --- |
| Frontend | Next.js (React), shadcn/ui, Tailwind, run on Bun | All UI: login, problem list/view, code editor, results, leaderboard, staff and admin consoles; Markdown rendering; SSE client for live status |
| Backend API | FastAPI (Python 3.12), SQLAlchemy (sync) | Auth and RBAC, problem and account management, package building, job enqueueing, judge event ingestion, scoring aggregation, CSV import/export |
| Background tasks | Same codebase, separate worker process (for example arq or Dramatiq on Redis) | Outbox retry for failed enqueues, package assembly after `build_done`, leaderboard cache refresh, stale-job detection |
| Relational DB | PostgreSQL 16+ | System of record |
| Queue / cache | Redis 7.x (AOF on) | Judge streams, stream registry, pub/sub for live updates, rate limits |
| Object storage | RustFS | Images, sources, staging and final packages, expected outputs |
| Judge | judge-worker-go + go-judge v1.13.3 | Compile, run, check and score submissions; build expected outputs |

### 3.2 Deployment view

- **App server:** frontend, API, background tasks, PostgreSQL, Redis, RustFS via Docker Compose behind a TLS reverse proxy (Caddy or Nginx).
- **Judge hosts (1..n):** each runs the `go-judge` + `judge-worker` pair from the judge repository, with a unique `WORKER_ID`, on an isolated network segment.
- **Network rules:** judge hosts may reach Redis, RustFS and `/internal/*` on the API only; the public internet reaches only the reverse proxy. `/internal/*` is served on the same port as the rest of the API: the reverse proxy refuses those paths from the public internet and passes them only from the judge network (NFR-SEC-06). RustFS is never exposed to browsers, so statement images are streamed by the API.

## 4. Functional requirements

Every requirement below is MUST unless marked otherwise. "Acceptance" lines state how a tester confirms it.

### 4.1 Authentication and sessions (FR-AUTH)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| FR-AUTH-01 | Users log in with a login ID and password on a single login page. | Valid credentials open the role's home page; invalid ones show a generic error without saying which field was wrong. |
| FR-AUTH-02 | Each account has exactly one role: `student`, `staff` or `admin`. | Role is shown in the user menu and enforced on every API call. |
| FR-AUTH-03 | Authorization is enforced server-side on every endpoint; the UI only hides what the role cannot use. | A student token calling a staff endpoint gets `403`. |
| FR-AUTH-04 | Sessions use an HTTP-only, Secure, SameSite cookie and expire 7 days after login (configurable). There is no idle timeout. | Cookie flags present; session expires as configured. |
| FR-AUTH-05 | Users can log out, which revokes the session server-side. | Reusing the old cookie after logout gets `401`. |
| FR-AUTH-06 | Users can change their own password (current password required, except while the account is flagged `must_change_password`). Their other sessions are signed out. | Old password stops working immediately. |
| FR-AUTH-07 | Accounts flagged `must_change_password` are forced to set a new password on first login, without entering the issued one again. | Generated student passwords trigger the prompt. |
| FR-AUTH-08 | Failed login attempts are counted per account and, separately, per client IP (default 10 failures / 15 min each). When either count is reached, further attempts are refused until its window ends. A successful login clears the account's count only. | After 10 failures the next attempt is refused with `429` (code `rate_limited`), also from another IP for the same account, and for another account from the same IP. |
| FR-AUTH-09 | Staff and admin can reset a student's password; admin can reset a staff password. The new password is shown once. | Reset password works; previous sessions are revoked. |
| FR-AUTH-10 | The first admin account is created by a CLI/seed command at install, never through the web UI. | Fresh install has no web path to create an admin. |

### 4.2 Admin (FR-ADM)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| FR-ADM-01 | Admin can create a staff account with display name, login ID and either a chosen or generated password. | New staff can log in and sees staff views. |
| FR-ADM-02 | Admin can list, edit (display name), deactivate and reactivate staff accounts. | A deactivated staff member cannot log in; their authored problems remain. |
| FR-ADM-03 | Admin has every staff permission (sections 4.3–4.6). | All staff acceptance tests pass with an admin account. |
| FR-ADM-04 | Admin cannot deactivate the last active admin. (Roles cannot be changed in the web UI, see 2.1.) | The action is refused with an explanation. |
| FR-ADM-05 | Admin can turn a global submission killswitch on and off, with an optional message for users. While it is on, the API refuses every new submission from students and staff (403, code submissions_closed), the Submit button is disabled and a banner with the message shows on every signed-in page. Problem pages re-read the setting every 5 s; other pages every 30 s. Submissions already queued or running are still judged and reported. Browsing problems, viewing results, the leaderboard, package builds and staff rejudges keep working. | With the switch on, a submit attempt is refused and nothing reaches Redis; queued jobs still finish. Turning it off restores submitting within 5 s on an open problem page. Both changes are written to the operation log. |

### 4.3 Problem management (FR-PRB)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| FR-PRB-01 | Staff see a list of all problems in the instance with title, status (draft / enabled / disabled), build status, allowed languages, submission count and last updated. | List shows every problem regardless of author. |
| FR-PRB-02 | Staff can enable or disable a problem with one toggle from the list and from the problem page. | Disabled problems disappear from student views within 5 s; existing submissions are kept. |
| FR-PRB-03 | A problem can only be enabled when it has a current version, that is, at least one successful build. A new version becomes the current one only when its build succeeds. While it builds, or if it fails, students keep using the previous good version and the problem stays enabled. | Toggle is disabled with a reason until the first build succeeds. A failed rebuild of an enabled problem changes nothing for students; staff see the failure in the editor. |
| FR-PRB-04 | Staff create and edit a problem with: title, slug, statement (Markdown), max points (default 100), time limit (ms), memory limit (MB), allowed languages, reference solution, test cases. | All fields save and reload unchanged. |
| FR-PRB-05 | The statement editor shows a live rendered preview using the same renderer students see (GitHub-flavoured Markdown, code highlighting, KaTeX math). | Preview and student view render identically. |
| FR-PRB-06 | Staff can upload images (PNG, JPEG, GIF, WebP, SVG sanitized; ≤ 5 MB each) by drag-and-drop or paste; the editor inserts a Markdown image link. | Uploaded image renders in preview and student view. |
| FR-PRB-07 | Staff select allowed languages from the judge's language registry; at least one is required. Time limit MAY be overridden per language (for example 3× for Python). | Students can only pick allowed languages; the API rejects others. |
| FR-PRB-08 | Staff write the reference solution in the web editor and choose its language. | Reference solution is stored and versioned with the problem. |
| FR-PRB-09 | Staff add test cases by typing input or uploading a `.in` file (≤ 8 MB each, ≤ 100 per problem). Test cases are ordered and can be reordered and deleted. | Order in the UI equals judge execution order. |
| FR-PRB-10 | Each test case has one visibility level: **hidden** (only the verdict is shown; default), **visible** (input, expected output and the student's output are shown in submission results), or **sample** (visible, and also shown on the problem page below the statement as input and expected output, before any submission). Samples are judged and scored like every other case. Changing a case's level creates a new version, because the package marks visible and sample cases `sample: true` so the judge returns output previews for them. | Hidden test data never appears in any student API response. Setting case 1 to sample shows it on the problem page; a visible case appears only in results. |
| FR-PRB-11 | Each test case MAY have a hint (plain text or Markdown, ≤ 1000 chars), shown to the student only when that test case does not pass. Editing a hint does not create a new version (FR-PRB-12). | Hint appears on a failing case and not on a passing one. |
| FR-PRB-12 | Changing only the title, statement or a test case hint does not create a version or trigger a build. Changing max points, the solution, test cases (inputs, order, visibility), limits, languages or output-checking mode creates a new problem version and triggers a package build (section 6.3). Max points is included because it is written into the package as the subtask's points. Hints are the one field that may be edited on an already built version. | Version number increments only on judge-relevant changes. |
| FR-PRB-13 | Build progress and result are shown on the problem page: expected outputs per test case (staff only), reference runtime per test case and the slowest time. If the reference fails (CE, TLE, RE…), the failing test case and log are shown. | A deliberately broken reference produces a readable failure. |
| FR-PRB-14 | Staff can preview a problem exactly as a student sees it and submit test solutions; staff submissions are excluded from the leaderboard and exports. | Staff submission is judged but not ranked. |
| FR-PRB-15 | Staff can delete a problem only if it has no student submissions; otherwise they can archive (disable permanently) it. Staff test submissions (FR-PRB-14) do not block deletion: they and their scores are deleted with the problem. | Delete is refused when student submissions exist, and works when only staff submissions exist. |
| FR-PRB-16 (SHOULD) | Staff can rejudge all submissions of a problem after a new version is built. Rejudges use the `rejudge` lane; each rejudged submission gets a new `job_id` and the next `attempt` number. | Scores update to the new version's results. |
| FR-PRB-17 | Staff choose the output-checking mode per problem: Lenient (whitespace and line breaks ignored, tokens compared) or Strict (default for new problems; tokens must match and the whitespace layout must match the expected output, else verdict PE). Optional float tolerance (absolute / relative) applies in both modes. Maps to checker.strict and float_abs / float_rel in problem.yaml. The editor warns that in Strict mode the reference solution's exact output, including trailing spaces, becomes the expected layout. | On a Strict problem, output "1  2" against answer "1 2" gets PE; on a Lenient problem it gets AC. A missing final newline or CRLF line endings are accepted in both. |

### 4.4 Student account management (FR-STU)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| FR-STU-01 | Staff can create a single student with display name and student ID; the system generates a password (12+ chars) and shows it once. | Student can log in with the shown password. |
| FR-STU-02 | Staff can bulk-create students by uploading a UTF-8 CSV with header `display_name,student_id`. | A 300-row file imports in under 10 s. |
| FR-STU-03 | Bulk import validates all rows before creating any: missing fields, duplicate IDs in the file, IDs that already exist. On any error, nothing is created and an error report lists row numbers and reasons. | A file with one bad row creates zero accounts. |
| FR-STU-04 | After a successful import, the system returns a downloadable CSV `student_id,display_name,password` with the generated passwords. Passwords are not retrievable later (only resettable). | Download works once per import; passwords are stored only as hashes. |
| FR-STU-05 | The student ID is the login ID. It is unique, case-insensitive, and limited to `[A-Za-z0-9._-]`, 1–64 chars. | `6512345` and ` 6512345  ` (trailing space) are treated as the same, trimmed. |
| FR-STU-06 | Staff can list, search, edit display name, deactivate/reactivate and reset password for students. | Deactivated students cannot log in and are hidden from the leaderboard. |

### 4.5 Submission monitoring and export (FR-MON)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| FR-MON-01 | Staff see a matrix of students × problems with each cell showing current score and status (not attempted / attempted / solved). | Matrix totals match the leaderboard. |
| FR-MON-02 | Staff can open any submission: source code, language, time, verdict, score, per-test-case results (for hidden cases too: verdict, time, memory and checker message), compiler log. The student's output is available only for sample and visible cases, because the judge never sends the output of hidden cases. | All fields visible to staff only. |
| FR-MON-03 | Staff can filter submissions by student, problem, verdict and date range. | Filters combine. |
| FR-MON-04 | Staff can export results as CSV: one row per student, columns `student_id, display_name`, one column per enabled problem (current score), and `total`. | Opens correctly in Excel and Google Sheets (UTF-8 with BOM). |
| FR-MON-05 (SHOULD) | Staff can also export a raw submissions CSV: `submission_id, student_id, problem_slug, language, verdict, score, submitted_at`. | Row count equals submission count for the filter. |
| FR-MON-06 | Submissions that end with `JE` (judge error) are flagged for staff review and excluded from scoring until resolved by a rejudge. | JE submissions show "under review" to the student. |
| FR-MON-07 | Staff can set the leaderboard to Live, Hidden or Frozen. Hidden removes it from student views. Frozen shows students the standings as of the freeze time while judging and scoring continue; unfreezing shows current standings. Staff and admin always see the live leaderboard, and each student always sees their own live scores on the problem list. | While hidden, the student leaderboard page and GET /leaderboard are unavailable to students (403). While frozen, submissions judged after the freeze time do not change the ranks students see. |

### 4.6 Student experience (FR-STD)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| FR-STD-01 | Students see a list of enabled problems with title, max points, their current score and completion status: **not attempted**, **attempted** (any submission, not full score), **solved** (current score is full). | Disabled problems never appear. |
| FR-STD-02 | Students see a leaderboard of active students ranked by total score (sum of current score per enabled problem). Ties break by earliest time the total was reached. | The student's own row is highlighted. |
| FR-STD-03 | The leaderboard shows rank, display name, total score and solved count. Student IDs are not shown to other students. | No student ID in the leaderboard response. |
| FR-STD-04 | Students see the rendered problem statement, limits, allowed languages and, below the statement, the sample test cases (input and expected output), with whitespace markers on Strict problems as in FR-STD-08. | Matches the staff preview. |
| FR-STD-05 | Students write code in an in-browser editor (CodeMirror 6 via React CodeMirror) with syntax highlighting for the selected language, and select a language from the problem's allowed list. | Switching language changes highlighting; the draft per language is kept in the browser. |
| FR-STD-06 | Students submit with one button. Source size ≤ 64 KB. Rate limit: 1 submission per 10 s per student, max 3 queued at once. | Excess submissions are refused with a clear message. Submitting to a problem whose current score is already full shows a warning that the new result will replace it (FR-JDG-06). |
| FR-STD-07 | After submitting, the student sees live status: queued → compiling → running (test *n* of *m*) → final verdict, without refreshing. | Status updates within 2 s of each judge event. |
| FR-STD-08 | The final report shows overall verdict, score, and for each test case: verdict, CPU time, memory. For sample and visible cases it also shows input, expected output and the student's output (preview). For failing cases it shows the hint if set. Compile errors show the compiler log. A presentation error (PE) on a sample or visible case shows the checker's message saying where the layout differs (for example, an extra space before token 2). On a hidden case only the PE label and its general explanation are shown, because the message would reveal the expected output's layout. On Strict problems, expected outputs and the student's output are shown with whitespace markers (· space, → tab, ↵ line end), on by default with a toggle to hide them; on Lenient problems they start off. | Hidden case data is never shown. On a Strict problem, a double space shows two · markers at the spot the PE message names. |
| FR-STD-09 | Students see their own submission history per problem and can reload any past source into the editor. | History lists every submission newest first. |

### 4.7 Judging (FR-JDG)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| FR-JDG-01 | On submit, the API stores the source in RustFS, creates a submission row (status `queued`), and enqueues a JudgeJob on the `practice` lane in the same flow. | No submission is ever stored without a queued job, or vice versa. |
| FR-JDG-02 | The API consumes judge events (section 6.4) and updates submission status and per-test results in PostgreSQL. | Events are applied exactly once even if delivered twice. |
| FR-JDG-03 | Score is computed by the judge (`score_milli`); the API stores it and converts to points with 2 decimals for display. | Displayed score = `score_milli` / 1000. |
| FR-JDG-04 | Default scoring: all test cases form one subtask in `sum` mode worth the problem's max points, so score = max points × fraction of test cases passed. | 7 of 10 passed on a 100-point problem = 70. |
| FR-JDG-05 | A submission whose job produces no `done` event within 15 min is shown as "delayed"; staff can requeue it. | Delayed state is visible to staff and the student. |
| FR-JDG-06 | A student's current score on a problem is the score of their most recent submission that finished judging with a scoring verdict (anything except SE and JE; CE scores 0). It is not the best score: a newer, lower result replaces an older, higher one. A submission still queued or running does not replace it until it finishes. A rejudge recomputes scores, and the latest submission's rejudged score becomes current. | Scoring 100 then 40 leaves the problem at 40; a later SE or JE result leaves it unchanged. |

## 5. Data model

PostgreSQL holds all authoritative state; RustFS holds blobs referenced by key; Redis holds only transient data that can be rebuilt.

### 5.1 PostgreSQL entities

| Entity | Key fields | Notes |
| --- | --- | --- |
| `users` | `id`, `login_id` (unique, citext), `display_name`, `role` (student/staff/admin), `password_hash` (argon2id), `must_change_password`, `is_active`, `created_by`, `created_at` | One table for all roles |
| `sessions` | `id` (SHA-256 of the cookie token), `user_id`, `csrf_token`, `created_at`, `last_seen_at`, `expires_at`, `revoked_at` | PostgreSQL is the source of truth; Redis holds a read cache. Revocation is immediate |
| `problems` | `id`, `slug` (unique), `title`, `statement_md`, `status` (draft/enabled/disabled/archived), `current_version_id`, `author_id`, `updated_at` | Statement edits do not create versions. `current_version_id` points at the latest version whose build succeeded |
| `problem_versions` | `id`, `problem_id`, `version` (int), `max_points`, `time_limit_ms`, `memory_limit_mb`, `checker_strict` (bool, default true), `float_abs`, `float_rel`, `reference_language`, `reference_source_key`, `package_sha256`, `package_key`, `build_status` (pending/ok/failed), `build_job_id`, `build_reason`, `build_failed_testcase`, `build_log`, `max_ref_time_ms`, `created_by`, `created_at` | Immutable once built, except test case hints |
| `problem_languages` | `problem_version_id`, `language_id`, `time_limit_ms` (override, nullable) | Allowed languages per version |
| `test_cases` | `id`, `problem_version_id`, `ordinal`, `name`, `input_key`, `answer_key`, `answer_sha256`, `visibility` (hidden/visible/sample), `hint_md`, `ref_time_ms` | `name` = file stem in the package (`1`, `2`, …) |
| `images` | `id`, `problem_id`, `object_key`, `mime`, `bytes`, `uploaded_by`, `created_at` |  |
| `submissions` | `id`, `user_id`, `problem_id`, `problem_version_id`, `language_id`, `source_key`, `source_sha256`, `status` (queued/compiling/running/done/delayed/review), `verdict`, `score_milli`, `attempt`, `job_id`, `is_staff`, `created_at`, `finished_at` | One row per submit |
| `submission_results` | `submission_id`, `test_case_id`, `attempt`, `verdict`, `time_ms`, `memory_kb`, `fraction`, `checker_msg`, `output_preview` | `output_preview` stored only for sample and visible cases |
| `judge_events` | `event_id` (PK), `submission_id`, `attempt`, `seq`, `type`, `received_at` | Idempotency log |
| `problem_scores` | `user_id`, `problem_id`, `score_milli`, `submission_id`, `submission_created_at`, `achieved_at` | Holds the latest judged submission's score; updated on every `done`; feeds list, leaderboard and export |
| `student_imports` | `id`, `staff_id`, `row_count`, `created_at` | Audit only; passwords never stored |
| `judge_outbox` | `id`, `job_id` (unique), `stream`, `payload`, `created_at`, `sent_at`, `tries`, `last_error` | Judge and build jobs waiting to be pushed to Redis (section 6.2) |
| `operation_logs` | `id`, `user_id`, `type` (dotted, e.g. `auth.login`), `info` (JSON text), `created_at` | The audit log: auth events, account, problem and settings changes (NFR-SEC-09) |
| `instance_settings` | `submissions_open` (bool), `submissions_message`, `leaderboard_mode` (live/hidden/frozen), `leaderboard_frozen_at`, `leaderboard_snapshot`, `updated_by`, `updated_at` | Single row; read on every submit |

### 5.2 RustFS buckets and keys

| Bucket | Key pattern | Content | Access |
| --- | --- | --- | --- |
| `assets` | `images/{problem_id}/{uuid}.{ext}` | Statement images | Streamed by the API (`GET /images/{id}`); never fetched from RustFS by the browser |
| `problems` | `staging/{sha256}.zip` | Package without expected outputs (input build) | Judge read-only key |
| `problems` | `packages/{sha256}.zip` | Final package with `.ans` files | Judge read-only key |
| `problems` | `answers/{version_id}/{n}.ans` | Expected outputs written by build jobs | Presigned PUT only |
| `problems` | `sources/{submission_id}/{file}` | Submission sources | Presigned GET to judge |
| `problems` | `testdata/{sha256}.in` | Test inputs, shared across versions | API only |
| `problems` | `reference/{version_id}/main.{ext}` | Reference solutions | Presigned GET to judge (build jobs) |

### 5.3 Redis keys

| Key | Type | Use |
| --- | --- | --- |
| `judge:{lane}:{course_id}` | stream | Judge jobs (`practice`, `rejudge`, `homework`) |
| `judge:build:_` | stream | Build jobs |
| `judge:streams:{lane}` | set | Stream registry required by the worker |
| `sub:{submission_id}` | pub/sub channel | Live status fan-out to the browser |
| `session:{sha256 of token}` | string with TTL | Session read cache (PostgreSQL is the source of truth) |
| `login_fail:id:{login_id}`, `login_fail:ip:{ip}` | counter with TTL | Failed-login counts (FR-AUTH-08) |
| `rl:*` | string with TTL | Submission rate limits |
| `lb:cache` | string with TTL 5 s | Cached leaderboard |

## 6. API and judge integration

The browser talks only to the Next.js frontend, which forwards `/api/*` to the FastAPI backend; the judge talks to Redis, RustFS and two internal API endpoints, never to PostgreSQL.

### 6.1 Public REST API (JSON)

The paths below are backend paths; they are not versioned. The browser calls the same path with an `/api` prefix on the frontend (`POST /api/auth/login`), and a frontend route handler forwards it.

| Area | Endpoints | Roles |
| --- | --- | --- |
| Auth | `POST /auth/login`, `POST /auth/logout`, `POST /auth/logout-all` (every session of the caller), `GET /auth/me`, `POST /auth/change-password` | All |
| Staff accounts | `GET/POST /staff`, `PATCH /staff/{id}`, `POST /staff/{id}/reset-password` | Admin |
| Students | `GET/POST /students`, `POST /students/import` (multipart CSV → result CSV), `PATCH /students/{id}`, `POST /students/{id}/reset-password` | Staff, admin |
| Problems (manage) | `GET/POST /admin/problems`, `GET/PATCH/DELETE /admin/problems/{id}`, `POST /admin/problems/{id}/enable`, `/disable`, `/archive`, `POST /admin/problems/{id}/images`, `POST /admin/problems/{id}/testdata`, `GET/POST /admin/problems/{id}/build`, `POST /admin/problems/{id}/rejudge` (not built yet), `GET /admin/languages`. `PATCH` saves the whole editor: its optional `config` holds limits, languages, checking mode, reference solution and the ordered test cases (each named by the SHA-256 that `/testdata` returned), so one save creates at most one version | Staff, admin |
| Problems (solve) | `GET /problems`, `GET /problems/{slug}` (statement, limits, languages, sample cases only), `GET /images/{id}` (statement image, streamed) | All |
| Submissions | `POST /problems/{slug}/submissions`, `GET /submissions?problem={slug}` (the caller's own, newest first), `GET /submissions/{id}` (`?student_view=true` gives staff the student shape), `GET /submissions/{id}/stream` (SSE) | Student: own only; staff: any single submission. The staff list of all submissions is `GET /admin/submissions` (Monitoring) |
| Monitoring | `GET /admin/progress` (matrix), `GET /admin/submissions` (filters), `GET /admin/export/scores.csv`, `GET /admin/export/submissions.csv` | Staff, admin |
| Leaderboard | `GET /leaderboard` | All |
| Meta | `GET /languages` (from a backend copy of the judge registry) | All |
| Instance settings | `GET /settings` (submissions open, banner message, leaderboard mode), `GET /settings/time` (server clock and UTC offset, for the top bar), `PUT /admin/settings/submissions` (killswitch), `PUT /admin/settings/leaderboard` (live / hidden / frozen) | Read: all; killswitch: admin; leaderboard: staff, admin |

The API MUST shape responses per role: the student serializer for a submission omits hidden test case output, expected output and every checker message on a hidden case (including PE messages), and shows `hint` only on failed cases.

Errors are JSON `{"detail": "Sentence for the user."}`. Where the UI must react to the kind of error, the body also has a stable `code`: `submissions_closed`, `rate_limited`, `language_not_allowed`, `problem_disabled`, `csv_invalid`. The UI shows `detail` and branches only on `code` or the HTTP status.

### 6.2 Submission flow

1. Browser posts `{language, source}`. API checks: submissions open (FR-ADM-05 killswitch off), problem enabled, language allowed, size ≤ 64 KB, rate limit.
2. API uploads the source to `problems/sources/{submission_id}/main.{ext}` and computes its SHA-256.
3. In one PostgreSQL transaction, the API inserts the `submissions` row (`queued`, `attempt = 1`, new ULID `job_id`) and a `judge_outbox` row holding the job.
4. In one Redis `MULTI`: `XADD judge:practice:{course_id} * data <JudgeJob>` and `SADD judge:streams:practice judge:practice:{course_id}`. On success the outbox row is marked sent. If Redis fails, the submission stays `queued` and a background task retries from the outbox. `delayed` is set only by the 15-minute rule (FR-JDG-05).
5. JudgeJob fields: `kind:"judge"`, `job_id`, `submission_id`, `attempt`, `course_id`, `lane`, `language`, `source.files[{name,url,sha256}]` with 30-minute presigned GET, `problem{id,version,package_sha256,package_key}`, `limits{time_ms,memory_mb}` resolved for the language, `feedback.preview_samples: true`, `created_at`.
6. Browser subscribes to `/submissions/{id}/stream`; the API relays Redis pub/sub updates as they arrive.

### 6.3 Problem package build flow

Expected outputs are generated, not typed. On a judge-relevant change (FR-PRB-12):

1. API writes `problem.yaml` + `tests/{n}.in` into a staging zip, uploads `staging/{sha256}.zip`.
2. `problem.yaml`: `type: batch`; `limits.memory_mb`; `limits.time_ms` with one entry per allowed language; `checker.kind: default`, `checker.strict` from the problem's checking mode, optional `float_abs` / `float_rel`; `testcases` in order with `sample: true` for sample and visible cases; one subtask `{index: 0, points: <max_points>, mode: sum, testcases: [all]}`.
3. API enqueues a BuildJob on `judge:build:_` with the reference solution, limits, and one presigned PUT URL per test case in `answers_upload`.
4. On `build_done` `ok: true`: API stores each answer's `sha256`, `bytes` and `time_ms` (the reference time of that test case), records `max_time_ms`, builds the final zip (staging contents + `tests/{n}.ans`), uploads `packages/{sha256}.zip`, marks the version `ok` and makes it the problem's current version.
5. On `ok: false`: version marked `failed` with `reason`, `testcase` and `log` shown to staff (FR-PRB-13). The version never becomes current: a problem that was already enabled keeps serving its previous version (FR-PRB-03).
6. The API SHOULD warn staff if `max_time_ms` exceeds 50% of the time limit for any language.

### 6.4 Judge events endpoint (`POST /internal/judge-events`)

| Rule | Requirement |
| --- | --- |
| Auth | Bearer token shared with the worker; the reverse proxy refuses `/internal/*` from the public internet |
| Body | One event object or a JSON array of up to 50 events; both MUST be accepted |
| Idempotency | `event_id` (`{submission_id}:{attempt}:{seq}`, or `build-{job_id}:{attempt}:{seq}` for build jobs) is the key; a duplicate returns `2xx` with no change |
| Superseded attempts | An event whose `attempt` is lower than the submission's current attempt returns `409` |
| Event types | `started` → status `compiling`; `compiled` (store log; `ok:false` precedes `done{CE}`); `test_result` → upsert per-test row, status `running`; `skipped`; `done` → final verdict, `score_milli`, `finished_at`, update `problem_scores`; `build_done` → section 6.3 |
| Verdicts accepted | `AC`, `PA`, `WA`, `PE`, `TLE`, `MLE`, `OLE`, `RE`, `CE`, `SE`, `JE`. An unknown verdict MUST be stored as-is and flagged, never rejected with `4xx` (the worker drops events on other `4xx`) |
| `PE` | Scores 0 like `WA`; shown with its own label, and with the checker message on sample and visible cases only |
| `JE` | Submission set to `review`, excluded from scoring (FR-MON-06) |
| `SE` | Shown as "system error, will be retried by staff"; `reason` visible to staff |
| Output preview | `output_preview` is stored only for `sample` (sample and visible) cases; the worker never sends hidden output |
| Latency | Respond within 500 ms p95. `problem_scores` is updated inside the `done` transaction (one upsert), so a finished submission never lacks its score; the leaderboard cache refresh and the pub/sub publish run after commit |

### 6.5 Job refresh endpoint (`POST /internal/judge-jobs/{job_id}/refresh`)

Returns `200` with the same JudgeJob JSON carrying fresh presigned URLs and the current `attempt`; `404` if the submission no longer exists (for example, deleted with its problem). Used by the worker for reclaimed jobs older than 25 minutes.

### 6.6 Lane usage

| Lane | Used for |
| --- | --- |
| `exam` | Not used in MVP (reserved) |
| `homework` | Not used in MVP (reserved for deadline-bound problems) |
| `rejudge` | Staff rejudges (FR-PRB-16), each with a new `job_id` |
| `practice` | All student and staff submissions |
| `build` | Package builds |

Because lanes are served in strict priority, a large rejudge delays new student submissions; the UI MUST warn staff before starting a rejudge of more than 200 submissions.

A rejudge replaces the submission's `job_id` with a new ULID and raises `attempt` by one. `job_id` is unique in `submissions` and `judge_outbox`, so reusing it would collide with the earlier outbox row; a worker still holding the old job gets `404` from the refresh endpoint or `409` on its events and drops it.

## 7. Non-functional requirements

Targets assume one course of up to 500 students and 100 problems on the default 4-slot judge host.

### 7.1 Security (NFR-SEC)

| ID | Requirement |
| --- | --- |
| NFR-SEC-01 | Passwords hashed with argon2id; generated passwords ≥ 12 chars from a CSPRNG; plaintext passwords exist only in the one-time response. |
| NFR-SEC-02 | All traffic over HTTPS; HSTS on; CSRF protection on cookie-authenticated state-changing requests. |
| NFR-SEC-03 | Markdown is rendered with raw HTML disabled or sanitized (allow-list); uploaded SVGs are sanitized; image MIME type checked by content, not extension. |
| NFR-SEC-04 | Untrusted code runs only inside go-judge on dedicated judge hosts; never on API, frontend or database hosts. |
| NFR-SEC-05 | Judge's RustFS key is read-only and scoped to the `problems` bucket; writes happen only through presigned PUT URLs. |
| NFR-SEC-06 | `/internal/*` endpoints are reachable only from the judge network and require the worker bearer token. They share the API's port, so the restriction is a reverse-proxy path rule and MUST be part of the deployment checklist. |
| NFR-SEC-07 | Hidden test inputs, expected outputs and the student's output on hidden cases never appear in student responses, logs visible to students or exports given to students. |
| NFR-SEC-08 | Secrets (DB, Redis, RustFS, worker token) come from environment or secret files, never from the repository. Accepted exception: the production Compose build copies `backend/.env` and `frontend/.env` into the images it builds on the app server. Those images MUST stay on that host and MUST NOT be pushed to a registry or shared. |
| NFR-SEC-09 | The operation log (`operation_logs`) records logins and failed logins, permission denials, account creation, deactivation, password changes and resets, problem enable/disable, rejudges, the submission killswitch and leaderboard mode changes. It never contains passwords or tokens. |

### 7.2 Performance (NFR-PERF)

| ID | Target |
| --- | --- |
| NFR-PERF-01 | Page API calls (problem list, problem view, leaderboard) p95 < 300 ms at 200 concurrent users. |
| NFR-PERF-02 | Submit request returns (submission queued) p95 < 500 ms. |
| NFR-PERF-03 | Queue wait (`judge_queue_wait_seconds`, practice lane) p95 < 30 s at 2 submissions/s sustained for 10 min. |
| NFR-PERF-04 | Browser shows each judge status change within 2 s of the event reaching the API. |
| NFR-PERF-05 | Leaderboard recomputation < 1 s for 500 students × 100 problems; cached 5 s. |
| NFR-PERF-06 | Judging capacity scales by adding judge hosts with no API change. |

### 7.3 Reliability (NFR-REL)

| ID | Requirement |
| --- | --- |
| NFR-REL-01 | No submission is lost: a queued job survives API, worker or Redis restarts (Redis AOF on, `appendfsync everysec`). |
| NFR-REL-02 | Event handling is idempotent and order-safe per attempt; a replayed spool produces the same final state. |
| NFR-REL-03 | PostgreSQL backed up daily with 14-day retention and point-in-time recovery; RustFS buckets `assets` and `problems` backed up daily. |
| NFR-REL-04 | Service availability 99.5% during the teaching term, excluding announced maintenance. |
| NFR-REL-05 | Judge results are deterministic: the same source on the same problem version gives the same verdict. |

### 7.4 Usability and accessibility (NFR-UX)

| ID | Requirement |
| --- | --- |
| NFR-UX-01 | UI built from shadcn/ui components; light and dark theme. |
| NFR-UX-02 | WCAG 2.1 AA for contrast, keyboard navigation and form labels. |
| NFR-UX-03 | Verdicts shown with a text label and colour, never colour alone; each verdict has a one-line plain-language explanation (for example PE: "Your answer is right but spacing or line breaks differ"). |
| NFR-UX-04 | UI text in English; times shown in the viewer's local timezone. |

### 7.5 Operability (NFR-OPS)

| ID | Requirement |
| --- | --- |
| NFR-OPS-01 | All services ship as Docker images with a Compose file for a single-server deployment (frontend, API, PostgreSQL, Redis, RustFS) plus separate judge hosts. |
| NFR-OPS-02 | API exposes `/healthz` and Prometheus `/metrics`; worker metrics (`:9100`) and go-judge metrics (`:5052`) are scraped. |
| NFR-OPS-03 | Alerts at minimum: practice queue backlog, any `JE`, SE above 1%, spool not draining, judge host missing. |
| NFR-OPS-04 | Deferred until after the MVP: schema changes via migrations (Alembic), zero manual SQL in deployment. Until then the API creates missing tables and indexes at startup (`create_all`), a change to an existing table needs manual SQL or a fresh database, and the API runs as a single worker process. |
| NFR-OPS-05 | The backend's language list is kept in sync with the judge's `languages.yaml` through configuration; a mismatch is reported at startup. |

## 8. Out of scope, open questions, sources

### 8.1 Out of scope for MVP

- Multiple courses per instance, enrolment, sections
- Deadlines, exams, timed contests (the `exam` / `homework` lanes are reserved for these)
- Interactive, output-only and custom-checker (testlib) problems; subtasks beyond the single `sum` subtask. The judge supports all of these, so they are a later UI/data change, not a judge change
- Plagiarism detection, manual grading, regrades by request
- SSO / LDAP / OAuth login, email, password-reset-by-email
- Student self-registration

### 8.2 Open questions

None remain; every question is settled in 8.3.

### 8.3 Resolved decisions

| Question | Decision | Reflected in |
| --- | --- | --- |
| Leaderboard visibility | Staff can hide or freeze it at any time | FR-MON-07, FR-STD-02 |
| Scoring rule | The latest judged submission counts, not the best | FR-JDG-06, Current score (1.4) |
| Output-checking default | Strict is the default for new problems; staff can switch a problem to Lenient | FR-PRB-17 |
| Show whitespace in expected outputs | Yes, with visible markers on Strict problems | FR-STD-08, FR-STD-04 |
| Per-test-case weights | Equal weight is enough for MVP | FR-JDG-04 |
| Languages at launch | Only C++20 (cpp20-gcc13) and Python 3.12 (py312) | 2.4 |
| Session lifetime | 7 days from login, no idle timeout | FR-AUTH-04 |
| Login rate limit | Separate counts per account and per IP, 10 failures / 15 min | FR-AUTH-08 |
| Role changes | None in the web UI; only the install CLI can make an admin | 2.1, FR-ADM-04 |
| Staff view of hidden-case output | Not available; the judge never sends it | FR-MON-02 |
| PE message on hidden cases | Not shown | FR-STD-08, 6.1, 6.4 |
| Reference time per test case | The judge reports it (`answers[].time_ms` in `build_done`) | 2.3, FR-PRB-13, 6.3 |
| What creates a version | Everything judge-relevant including max points; hints are edited in place | FR-PRB-12 |
| Rebuilding an enabled problem | The previous good version stays live until the new build succeeds | FR-PRB-03, 6.3 |
| Deleting a problem | Blocked by student submissions only; staff test submissions are deleted with it | FR-PRB-15 |
| Score update timing | Inside the `done` transaction | 6.4 |
| Redis down at submit | Submission stays `queued`; the outbox retries | 6.2 |
| Statement images | Streamed by the API | 3.2, 5.2 |
| Judge access to `/internal/*` | Same port as the API, restricted by reverse-proxy path rules | 3.2, NFR-SEC-06 |
| Secrets in images | Allowed for the locally built production images only | NFR-SEC-08 |
| API paths and errors | Unversioned backend paths; errors are `detail` plus optional `code` | 6.1 |
| Audit storage | The existing `operation_logs` table | 5.1, NFR-SEC-09 |
| Migrations and tests | Alembic and the automated test suites are deferred past the MVP | NFR-OPS-04 |

### 8.4 Sources

- [judge-worker-go README](https://github.com/User-NotExist/judge-worker-go) — job queue, package format, events API, verdicts; checked against commit `ec4ed6a` (feat: presentation error, 3 Nov 2026) plus the per-answer `time_ms` field added to `build_done` for FR-PRB-13
- Original MVP brief supplied by the requester
