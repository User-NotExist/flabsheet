# Database and object storage

PostgreSQL is the system of record for every user, problem, submission and score; MongoDB holds data shaped as one self-contained document per thing and read as a whole: the operation log and the per-test submission reports (written once per event), and the clarification threads and notifications (edited in place, one document at a time); RustFS holds the files those rows point to, addressed by key and checked by SHA-256. Redis holds only rebuildable data and is not covered here.

## Entity relationships

```
sessions ──▶ users ◀── problems ◀── images
problem_scores ──▶ users            problems ◀── problem_versions ◀── problem_languages
problem_scores ──▶ submissions      problem_versions ◀── test_cases
submissions ──▶ users, problems, problem_versions
judge_events ──▶ submissions
Supporting: judge_outbox, instance_settings (1 row), student_imports
(arrow = foreign key, child ──▶ parent)

MongoDB (no foreign keys; the ids refer to Postgres rows):
operation_logs.user_id ··▶ users
submission_reports.submission_id, problem_id, user_id ··▶ submissions, problems, users
submission_reports.results.<test_case_id> ··▶ test_cases
clarifications.problem_id ··▶ problems        (null = course-wide announcement)
clarifications.author_id, replies[].author_id ··▶ users
notifications.user_id ··▶ users
notifications.data.problem_id ··▶ problems    (answers and problem announcements)
```

A problem changes only through new versions, and each submission records the version it was judged against, so old results stay explainable after edits. Two shortcut keys are left out of the drawing for clarity: `submissions.problem_id` and `problem_scores.problem_id` both point at `problems`.

## Schema

This is the schema that the SQLAlchemy models in `backend/db/models/` create at startup (`create_all`), written as PostgreSQL 16 DDL. There are no migrations yet (SRS NFR-OPS-04): the models are authoritative, so change them and this listing together, and remember that `create_all` never alters a table that already exists. Scores are integer milli-points; every timestamp is `timestamptz`; users are deactivated, never deleted.

```sql
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE user_role         AS ENUM ('student', 'staff', 'admin');
CREATE TYPE problem_status    AS ENUM ('draft', 'enabled', 'disabled', 'archived');
CREATE TYPE build_status      AS ENUM ('pending', 'ok', 'failed');
CREATE TYPE tc_visibility     AS ENUM ('hidden', 'visible', 'sample');
CREATE TYPE submission_status AS ENUM ('queued', 'compiling', 'running', 'done', 'delayed', 'review');
CREATE TYPE leaderboard_mode  AS ENUM ('live', 'hidden', 'frozen');

-- Accounts -------------------------------------------------------------
CREATE TABLE users (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  login_id             citext NOT NULL UNIQUE CHECK (login_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  display_name         text   NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  role                 user_role NOT NULL,
  password_hash        text   NOT NULL,              -- argon2id encoded string: algorithm, cost settings, random 16-byte salt and hash in one value
  must_change_password boolean NOT NULL DEFAULT false,
  is_active            boolean NOT NULL DEFAULT true,
  created_by           bigint REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id           text PRIMARY KEY,                    -- SHA-256 of the cookie token, never the token
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   text   NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,                -- created_at + 7 days
  revoked_at   timestamptz
);

CREATE TABLE student_imports (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_id   bigint NOT NULL REFERENCES users(id),
  row_count  int    NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()  -- passwords are never stored here
);

-- Problems ---------------------------------------------------------------
CREATE TABLE problems (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug               citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{1,64}$'),
  title              text   NOT NULL,
  statement_md       text   NOT NULL DEFAULT '',
  status             problem_status NOT NULL DEFAULT 'draft',
  current_version_id bigint,                         -- latest version whose build is ok; FK added below
  author_id          bigint NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE problem_versions (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  problem_id            bigint NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  version               int    NOT NULL,
  max_points            int    NOT NULL DEFAULT 100 CHECK (max_points > 0),  -- written into the package as subtask points
  time_limit_ms         int    NOT NULL CHECK (time_limit_ms BETWEEN 1 AND 60000),
  memory_limit_mb       int    NOT NULL CHECK (memory_limit_mb BETWEEN 1 AND 8192),
  checker_strict        boolean NOT NULL DEFAULT true,
  float_abs             double precision,
  float_rel             double precision,
  reference_language    text   NOT NULL,
  reference_source_key  text   NOT NULL,
  package_sha256        char(64),
  package_key           text,
  build_status          build_status NOT NULL DEFAULT 'pending',
  build_job_id          text,
  build_reason          text,
  build_failed_testcase text,
  build_log             text,
  max_ref_time_ms       int,
  created_by            bigint NOT NULL REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (problem_id, version),
  UNIQUE (problem_id, id)                           -- target of the composite FK below
);

-- current_version_id must belong to the same problem
ALTER TABLE problems ADD CONSTRAINT problems_current_version_fk
  FOREIGN KEY (id, current_version_id) REFERENCES problem_versions (problem_id, id);

CREATE TABLE problem_languages (
  problem_version_id bigint NOT NULL REFERENCES problem_versions(id) ON DELETE CASCADE,
  language_id        text   NOT NULL,                -- e.g. cpp20-gcc13, py312
  time_limit_ms      int    CHECK (time_limit_ms BETWEEN 1 AND 60000),  -- NULL = version default
  PRIMARY KEY (problem_version_id, language_id)
);

CREATE TABLE test_cases (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  problem_version_id bigint NOT NULL REFERENCES problem_versions(id) ON DELETE CASCADE,
  ordinal            int    NOT NULL,                -- execution order, 1-based
  name               text   NOT NULL,                -- file stem in the package: '1', '2', ...
  input_key          text   NOT NULL,
  input_sha256       char(64) NOT NULL,
  input_bytes        int    NOT NULL CHECK (input_bytes <= 8388608),
  answer_key         text,                           -- set after a successful build
  answer_sha256      char(64),
  answer_bytes       int,
  visibility         tc_visibility NOT NULL DEFAULT 'hidden',
  hint_md            text   CHECK (length(hint_md) <= 1000),  -- the one column editable after the build
  ref_time_ms        int,                            -- build_done answers[].time_ms
  UNIQUE (problem_version_id, ordinal),
  UNIQUE (problem_version_id, name)
);

CREATE TABLE images (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  problem_id  bigint NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  object_key  text   NOT NULL UNIQUE,
  mime        text   NOT NULL,
  bytes       int    NOT NULL CHECK (bytes <= 5242880),
  sha256      char(64) NOT NULL,
  uploaded_by bigint NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Submissions and judging ----------------------------------------------------
CREATE TABLE submissions (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            bigint NOT NULL REFERENCES users(id),
  problem_id         bigint NOT NULL REFERENCES problems(id) ON DELETE RESTRICT,
  problem_version_id bigint NOT NULL REFERENCES problem_versions(id) ON DELETE RESTRICT,
  language_id        text   NOT NULL,
  source_key         text   NOT NULL,
  source_sha256      char(64) NOT NULL,
  source_bytes       int    NOT NULL CHECK (source_bytes <= 65536),
  is_staff           boolean NOT NULL,
  status             submission_status NOT NULL DEFAULT 'queued',
  verdict            text,                           -- free text: unknown verdicts are kept
  verdict_unknown    boolean NOT NULL DEFAULT false,
  score_milli        int,
  judge_reason       text,                           -- done.reason for SE / JE
  attempt            int    NOT NULL DEFAULT 1,
  job_id             text   NOT NULL UNIQUE,         -- ULID; replaced by a new one on every rejudge
  lane               text   NOT NULL DEFAULT 'practice',
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  finished_at        timestamptz
);

CREATE TABLE judge_events (
  event_id      text PRIMARY KEY,                    -- idempotency key from the worker
  submission_id bigint REFERENCES submissions(id) ON DELETE CASCADE,  -- NULL for build events
  job_id        text NOT NULL,
  attempt       int  NOT NULL,
  seq           int  NOT NULL,
  type          text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE judge_outbox (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id     text  NOT NULL UNIQUE,
  stream     text  NOT NULL,                         -- judge:practice:1, judge:build:_ ...
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz,
  tries      int   NOT NULL DEFAULT 0,
  last_error text
);

CREATE TABLE problem_scores (
  user_id              bigint NOT NULL REFERENCES users(id),
  problem_id           bigint NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  submission_id        bigint NOT NULL REFERENCES submissions(id),
  submission_created_at timestamptz NOT NULL,         -- decides which submission is latest
  score_milli          int    NOT NULL,
  achieved_at          timestamptz NOT NULL,          -- when this score became current
  PRIMARY KEY (user_id, problem_id)
);

-- Instance ---------------------------------------------------------------------
CREATE TABLE instance_settings (
  id                    smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  submissions_open      boolean NOT NULL DEFAULT true,
  submissions_message   text,
  leaderboard_mode      leaderboard_mode NOT NULL DEFAULT 'live',
  leaderboard_frozen_at timestamptz,
  leaderboard_snapshot  jsonb,                        -- standings served while frozen
  updated_by            bigint REFERENCES users(id),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO instance_settings DEFAULT VALUES;
```

The operation log, the per-test results and the compile log used to be the tables `operation_logs` and `submission_results` and the column `submissions.compile_log`; they now live in MongoDB (section "MongoDB" below). A database created by an older version still has them, and `create_all` never drops anything:

1. `python cli.py migrate-to-mongo` copies them into MongoDB and verifies the copy. It never changes Postgres and is safe to run again.
2. Check the log page and a few result pages.
3. `python cli.py migrate-to-mongo --drop-old` (asks first; `--yes` skips the prompt) copies again, then in one Postgres transaction locks the old data, copies once more, verifies that every row is in MongoDB and runs:

```sql
DROP TABLE IF EXISTS submission_results;
DROP TABLE IF EXISTS operation_logs;
ALTER TABLE submissions DROP COLUMN IF EXISTS compile_log;
```

If any row is missing nothing is dropped. The lock waits at most 5 s for the live app's transactions and blocks submits for the few seconds the final pass takes.

The first draft of this schema was checked by running it on PostgreSQL 16.15 together with the indexes below and a smoke test of the rules in the next section. It has not been re-run since `max_points` moved to `problem_versions` and `audit_log` was replaced by `operation_logs`; the Compose image is pinned to PostgreSQL 16.4.

## Indexes and integrity rules

Every index below serves a named screen or job; add others only after a slow query shows up in `pg_stat_statements`.

```sql
CREATE INDEX submissions_user_problem_idx ON submissions (user_id, problem_id, created_at DESC);
CREATE INDEX submissions_problem_idx      ON submissions (problem_id, created_at DESC);
CREATE INDEX submissions_active_idx       ON submissions (user_id)    WHERE status IN ('queued', 'compiling', 'running');
CREATE INDEX submissions_stale_idx        ON submissions (created_at) WHERE status IN ('queued', 'compiling', 'running');
CREATE INDEX submissions_review_idx       ON submissions (created_at) WHERE status = 'review';
CREATE INDEX problem_scores_problem_idx   ON problem_scores (problem_id);
CREATE INDEX judge_events_submission_idx  ON judge_events (submission_id);
CREATE INDEX judge_outbox_unsent_idx      ON judge_outbox (created_at) WHERE sent_at IS NULL;
CREATE INDEX sessions_user_idx            ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx          ON sessions (expires_at);
```

| Index | Serves |
| --- | --- |
| `submissions_user_problem_idx` | Student history per problem, latest submission lookup |
| `submissions_problem_idx` | Staff submission browser, rejudge |
| `submissions_active_idx` | The "max 3 queued" check on every submit |
| `submissions_stale_idx` | `detect_delayed` job (15-min rule) |
| `submissions_review_idx` | JE review queue |
| `problem_scores_problem_idx` | Progress matrix and exports (the PK already covers per-user reads) |
| `judge_outbox_unsent_idx` | `flush_outbox` job |
| `sessions_*` | Revoke all of a user's sessions; purge expired sessions |

A problem's versions are found through the unique index on `(problem_id, version)`, so `problem_versions` needs no index of its own.

**Rules the database enforces**

- A problem's current version belongs to that problem (composite foreign key; tested).
- Login IDs and slugs are unique regardless of case (`citext`; tested).
- A problem with submissions cannot be deleted (`ON DELETE RESTRICT`; tested); without submissions, its versions, test cases, languages and images go with it.
- Size caps from the SRS: source ≤ 64 KB, test input ≤ 8 MB, image ≤ 5 MB, hint ≤ 1000 characters.
- One settings row only (`CHECK (id = 1)`).

**Rules the backend enforces**

- A version is frozen once its build is `ok`: any judge-relevant change, including max points, creates a new version (FR-PRB-12). Test case rows are copied to the new version; their storage objects are shared, not copied. The one exception is `test_cases.hint_md`, which is edited in place.
- `problems.current_version_id` moves only when a version's build becomes `ok`. Until then, and after a failed build, students keep the previous version (FR-PRB-03).
- Deleting a problem (FR-PRB-15): in one transaction, delete the problem's `problem_scores` rows and submissions where `is_staff` is true, then the problem. `ON DELETE RESTRICT` still refuses the delete if a student submission remains.
- A rejudge writes a new ULID into `submissions.job_id` and increments `attempt`, because `job_id` is unique here and in `judge_outbox`.
- At most 100 test cases per version.
- The current score follows the latest submission by submit time, not finish time. Run this inside the `done` transaction (tested: a newer 40-point result is kept when an older 100-point result finishes after it):

```sql
INSERT INTO problem_scores AS ps
  (user_id, problem_id, submission_id, submission_created_at, score_milli, achieved_at)
VALUES ($1, $2, $3, $4, $5, now())
ON CONFLICT (user_id, problem_id) DO UPDATE
  SET submission_id         = EXCLUDED.submission_id,
      submission_created_at = EXCLUDED.submission_created_at,
      score_milli           = EXCLUDED.score_milli,
      achieved_at = CASE WHEN ps.score_milli = EXCLUDED.score_milli
                         THEN ps.achieved_at ELSE now() END
  WHERE EXCLUDED.submission_created_at >= ps.submission_created_at;
```

Skip the call entirely for SE and JE results, so they never replace a score (FR-JDG-06).

## MongoDB

A standalone MongoDB 8.0 server (`infra/compose.yaml`, database `MONGO_DB`, default `flabsheet`) holds four collections. Every write is atomic on one document (an announcement's fan-out is one `insert_many` of independent documents), so no replica set or multi-document transaction is needed. `db/mongo.py` creates the indexes at startup (`ensure_indexes`, next to `create_all`).

### `operation_logs`

One document per audit event, written through `services/operation_log.py`.

```js
{
  _id:        ObjectId,           // also the tie-break for equal created_at
  created_at: ISODate,            // set by the backend when the event is logged
  type:       "auth.login_failed",// dotted snake_case: auth.login, user.create, problem.enable, settings.killswitch
  user_id:    42 | null,          // users.id of who did it; null for system events
  info:       { ip: "…" } | "text" | null,  // details (target ids, IP); never passwords or tokens
  legacy_id:  1234                // only on entries copied from the old Postgres table
}
```

| Index | Serves |
| --- | --- |
| `{created_at: -1, _id: -1}` | Newest-first log listing |
| `{type: 1, created_at: -1}` | Filter by type |
| `{user_id: 1, created_at: -1}` | Filter by user (ids found in Postgres by login id or name) |
| `{legacy_id: 1}` unique, partial | `migrate-to-mongo` can run twice |

**Write rule:** `log_operation(db, …)` queues the entry on the SQLAlchemy session and an `after_commit` hook inserts it, so an operation that rolls back leaves no entry. The insert is best effort, like Redis: while MongoDB is down the entry is lost with a warning and the request still succeeds. `log_operation_now` inserts at once, for entries that must outlive a failed request.

### `submission_reports`

One document per submission attempt, written by `apply_event` through `services/reports.py`.

```js
{
  _id:           "123:2",         // "{submission_id}:{attempt}"
  submission_id: 123, attempt: 2, problem_id: 7, user_id: 42,
  compile_log:   "…" | null,      // ≤ 64 KiB, from the `compiled` event
  updated_at:    ISODate,
  results: {                      // keyed by test_cases.id
    "45": { verdict: "AC", time_ms: 12, memory_kb: 3400, fraction: 1.0,
            checker_msg: "…",            // ≤ 1 KiB from the judge
            output_preview: "…" | null,  // sample and visible cases only (NFR-SEC-07)
            preview_truncated: false }
  }
}
```

| Index | Serves |
| --- | --- |
| `_id` | Result page and live progress: the current attempt by key |
| `{submission_id: 1, attempt: -1}` | All attempts of one submission |
| `{problem_id: 1}` | Deleting a problem's reports |

**Write rule:** `apply_event` locks the submission and inserts the `judge_events` row, writes the document, and only then commits Postgres. Each write is an idempotent `$set` on a fixed key (`results.<test_case_id>`, `compile_log`), so a failed commit is repaired by the judge's retry, and a MongoDB error rolls the event back (503, the judge retries). A rejudge starts a new attempt and therefore a new document; readers always ask for `submissions.attempt`, and older attempts stay as history. Deleting a problem removes its reports after the commit, best effort.

### `clarifications`

One document per Q&A thread or announcement, with its replies embedded, written by `routers/clarifications.py` with the rules in `services/clarifications.py`.

```js
{
  _id:        ObjectId,
  problem_id: 7 | null,            // problems.id; null = course-wide announcement
  author_id:  42,                  // users.id
  kind:       "question" | "announcement",
  title:      "…",                 // 1–200 chars
  body_md:    "…",                 // 1–5000 chars, Markdown (rendered sanitised, images only from this site)
  visibility: "public" | "private",// private = author + staff; announcements are always public
  status:     "open" | "answered" | "closed",  // announcements start "closed": no answer is awaited
  pinned:     false,
  replies: [ { _id: ObjectId, author_id: 42, role: "student" | "staff" | "admin",  // role when replying
               body_md: "…", created_at: ISODate, edited_at: ISODate | null } ],   // at most 100
  tags:       ["output"],          // at most 5, 1–32 chars each, no repeats
  created_at: ISODate,
  updated_at: ISODate              // any change, including a reply: "last activity"
}
```

| Index | Serves |
| --- | --- |
| `{problem_id: 1, pinned: -1, updated_at: -1}` | A problem's Clarifications tab, pinned first; with `problem_id: null`, the dashboard's course-wide announcements; deleting a problem's threads |
| `{author_id: 1, created_at: -1}` | A student's own questions (`GET /clarifications` as a student) |
| `{status: 1, updated_at: -1}` | The staff queue (`/manage/clarifications`), open questions first by default |

**Write rules:**

- Students read public threads and their own, and only on problems they can open now (enabled); anything else answers 404, like a draft on the solve page. They edit their own question while it is `open` with no staff reply, delete it while it has no replies, reply to it unless `closed`, and edit or delete their own replies. Staff and admins do all of that on any thread, and post announcements, set the status, pin and change the visibility.
- Every conditional write carries its condition in the filter (`status: "open"`, `"replies.role": {$nin: ["staff", "admin"]}`, `replies: {$size: 0}`, `"replies.99": {$exists: false}`), so a concurrent reply cannot slip between the check and the write.
- Each reply change touches one array element: `$push` adds, `$set` on `replies.$` (found with `$elemMatch` on the reply id) edits, `$pull` deletes. Each also sets `updated_at`.
- A staff reply sets a question's `status` to `answered` and notifies its author; the author's follow-up on an answered question sets it back to `open`, so it returns to the queue.
- Author names, roles and problem titles are read from Postgres in one batched query per response, never per row.
- No route here writes to Postgres, so the operation log entry (`clarification.create`, `.announce`, `.update`, `.delete`, `.reply`, `.reply_update`, `.reply_delete`) is written with `log_operation_now` after the MongoDB write succeeds.
- Deleting a problem removes its threads after the Postgres commit, best effort, like its reports.
- Image links in threads are not seen by the orphan sweep (it reads `statement_md` and `hint_md` only), so an image linked only from a thread is removed 24 h after its last statement link goes.

### `notifications`

One document per user per event, written by `services/notifications.py`.

```js
{
  _id:        ObjectId,
  user_id:    42,                  // users.id of the recipient
  type:       "clarification.answered" | "clarification.new" | "announcement" | "manual",
  title:      "…",                 // ≤ 200 chars
  body:       "…" | null,          // ≤ 1000 chars, plain text
  link:       "/problems/two-sum#clarifications" | null,   // a path on this site, never another site
  data:       { clarification_id: "…", problem_id: 7 },    // differs by type; {} for manual
  is_read:    false,
  created_at: ISODate              // the TTL index removes the document 90 days later
}
```

| Index | Serves |
| --- | --- |
| `{user_id: 1, is_read: 1, created_at: -1}` | The bell's unread count, the `/notifications` list (queried with `is_read: {$in: [false, true]}` so the two ranges merge in date order), mark all read, clear read |
| `{created_at: 1}` TTL, `expireAfterSeconds: 7776000` | Removes notifications after 90 days |

**Write rules:**

- A staff reply on a question notifies its author (`clarification.answered`); a new student question notifies nobody (staff work from the queue); an announcement notifies every active student (one `insert_many`; for a problem announcement only if the problem is enabled); staff can send a `manual` one to one active student or to all. `clarification.new` is reserved and not written yet.
- Writing a notification is best effort, like the operation log: a MongoDB failure is logged as a warning and never fails the reply or announcement that caused it. Only a manual send, where the notification is the whole request, answers 503.
- Every read and change filters on `user_id` = the caller, so another user's notification answers 404. Each change is logged with `log_operation_now` (`notification.update`, `.read_all`, `.delete`, `.clear_read`, `.send`).
- Deleting a problem also removes notifications whose `data.problem_id` names it, after the commit, best effort.

## Object storage

Two RustFS buckets hold every file; the browser never gets storage credentials or storage URLs, and the judge gets only a read-only key for `problems` plus short-lived presigned URLs.

| Key | Bucket | Content | Written by | Read by | Cap | Changes? |
| --- | --- | --- | --- | --- | --- | --- |
| `images/{problem_id}/{uuid}.{ext}` | `assets` | Statement images | API (staff upload) | Browser, via `GET /images/{id}` on the API (`/api/images/{id}` from the browser), which streams the bytes. No redirect: RustFS is not reachable from the internet | 5 MB | Never; deleted by the orphan sweep once no statement or hint links it |
| `testdata/{sha256}.in` | `problems` | Test inputs, shared across versions | API | API (package build) | 8 MB | Never (content-addressed) |
| `reference/{version_id}/main.{ext}` | `problems` | Reference solution | API | Judge, presigned GET in the build job | 64 KB | Never |
| `staging/{sha256}.zip` | `problems` | Package without answers | API | Judge (read-only key) | — | Never |
| `answers/{version_id}/{name}.ans` | `problems` | Expected outputs | Judge, presigned PUT | API (final package, staff view) | — | Never |
| `packages/{sha256}.zip` | `problems` | Final package with answers | API | Judge (read-only key, cached by SHA) | — | Never |
| `sources/{submission_id}/main.{ext}` | `problems` | Submitted code | API | Judge (presigned GET); API for history and staff view | 64 KB | Never |

Object rules:

- Every object is written once and never overwritten; a change produces a new key. This keeps judge caches and backups simple.
- Set `Content-Type` on upload. Serve images with `Content-Security-Policy: sandbox` and SVGs only after sanitising (NFR-SEC-03).
- Store the SHA-256 in the database for anything the judge or API verifies (inputs, answers, packages, sources).
- Access keys: the API uses a read-write key for both buckets; the judge uses a separate key limited to reading `problems` (NFR-SEC-05). Create the judge key in the RustFS console; the compose file's root key is for the API and setup only.

## Keeping database and storage consistent

PostgreSQL, MongoDB and RustFS cannot share a transaction (the MongoDB write order is in the section above), so the order of writes decides what a crash leaves behind: an unused file, never a row pointing at nothing.

1. **Upload first, then insert the row.** If the API dies between the two, the file is an orphan and the user retries.
2. **Delete the row first, then the file.** Files are never deleted inline; the sweep below removes them.
3. **Content-addressed keys** (`testdata/`, `staging/`, `packages/`) make retries harmless: the same bytes land on the same key.
4. **Verify hashes** where data crosses a boundary: the judge checks sources and packages; the API checks each answer against `build_done` before building the final package.
5. **Orphan sweep** (weekly background job, `sweep_orphans`): delete objects older than 24 h that no row references. The 24 h gap protects uploads still in progress. Only `images/` is swept so far; the other prefixes are listed here as planned.
   - **Images, pass 1: unlinked rows.** An `images` row older than 24 h whose id no `/images/{id}` link names, in any problem's `statement_md` or any test case's `hint_md`, is deleted. Every problem's text counts, because a statement copied from another problem keeps that problem's links. The 24 h gap also protects an image inserted in an editor that has not been saved yet.
   - **Images, pass 2: files with no row.** An object under `images/` older than 24 h whose key no `images.object_key` holds is deleted. This removes the files of pass 1, of deleted problems (their rows cascade away) and of uploads that failed before the row was inserted.
   - The passes run in this order, so the rule above holds: row first, then file.
   - `ORPHAN_SWEEP_ENABLED=false` (backend `.env`) turns the job off.

## Backups and restore

Back up PostgreSQL, MongoDB and both buckets daily; restore the databases first and keep the orphan sweep off (`ORPHAN_SWEEP_ENABLED=false`) until the restore is checked. A restored database that is older than the buckets would otherwise make newer images look orphaned.

| What | How | Kept |
| --- | --- | --- |
| PostgreSQL | Nightly base backup + continuous WAL archiving for point-in-time recovery | 14 days (NFR-REL-03) |
| MongoDB | Nightly `mongodump --gzip` of the `flabsheet` database | 14 days |
| `assets`, `problems` buckets | Nightly incremental sync to a second location (another S3 target or disk); objects never change, so only new files copy | 14 days of daily snapshots |
| Redis | AOF only, no backup. After a loss, `flush_outbox` re-sends unsent jobs and `detect_delayed` flags anything left `queued` for staff to requeue | — |

Restore order:

1. Stop the API and the worker.
2. Restore PostgreSQL to the chosen time, and MongoDB from the same night (`mongorestore --drop`). Log entries, reports, clarification threads and notifications newer than the dump are lost; a submission whose report is missing shows no per-test results until it is rejudged.
3. Restore both buckets from the same night or later. Extra newer files are harmless; missing files are not.
4. Start the API, check a problem page, a package build and an old submission's source, then re-enable the sweep job (`ORPHAN_SWEEP_ENABLED=true`, restart the worker).

Run this once on staging before launch.
