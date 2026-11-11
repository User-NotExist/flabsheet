# Database and object storage

PostgreSQL is the system of record for every user, problem, submission and score; RustFS holds the files those rows point to, addressed by key and checked by SHA-256. Redis holds only rebuildable data and is not covered here.

## Entity relationships

```
sessions ──▶ users ◀── problems ◀── images
problem_scores ──▶ users            problems ◀── problem_versions ◀── problem_languages
problem_scores ──▶ submissions      problem_versions ◀── test_cases
submissions ──▶ users, problems, problem_versions
submission_results ──▶ submissions, test_cases
judge_events ──▶ submissions
Supporting: judge_outbox, instance_settings (1 row), operation_logs, student_imports
(arrow = foreign key, child ──▶ parent)
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
  compile_log        text,
  attempt            int    NOT NULL DEFAULT 1,
  job_id             text   NOT NULL UNIQUE,         -- ULID; replaced by a new one on every rejudge
  lane               text   NOT NULL DEFAULT 'practice',
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  finished_at        timestamptz
);

CREATE TABLE submission_results (
  submission_id     bigint NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  test_case_id      bigint NOT NULL REFERENCES test_cases(id),
  attempt           int    NOT NULL,
  verdict           text   NOT NULL,
  time_ms           int,
  memory_kb         int,
  fraction          numeric(7,6),
  checker_msg       text,                            -- ≤ 1 KiB from the judge
  output_preview    text,                            -- sample and visible cases only
  preview_truncated boolean NOT NULL DEFAULT false,
  PRIMARY KEY (submission_id, test_case_id)          -- rows of an older attempt are cleared
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

-- Instance and audit -----------------------------------------------------------
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

-- The audit log. Written through services/operation_log.py.
CREATE TABLE operation_logs (
  id         bigserial PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  user_id    bigint REFERENCES users(id) ON DELETE SET NULL,  -- who did it; NULL for system events
  type       text NOT NULL,                          -- dotted snake_case: auth.login_failed, user.create, problem.enable, settings.killswitch
  info       text                                    -- JSON text with the details (target ids, IP); never passwords or tokens
);
```

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
CREATE INDEX operation_logs_created_at_idx ON operation_logs (created_at DESC);
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
| `operation_logs_created_at_idx` | Newest-first log listing |

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

## Object storage

Two RustFS buckets hold every file; the browser never gets storage credentials or storage URLs, and the judge gets only a read-only key for `problems` plus short-lived presigned URLs.

| Key | Bucket | Content | Written by | Read by | Cap | Changes? |
| --- | --- | --- | --- | --- | --- | --- |
| `images/{problem_id}/{uuid}.{ext}` | `assets` | Statement images | API (staff upload) | Browser, via `GET /images/{id}` on the API (`/api/images/{id}` from the browser), which streams the bytes. No redirect: RustFS is not reachable from the internet | 5 MB | Never |
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

PostgreSQL and RustFS cannot share a transaction, so the order of writes decides what a crash leaves behind: an unused file, never a row pointing at nothing.

1. **Upload first, then insert the row.** If the API dies between the two, the file is an orphan and the user retries.
2. **Delete the row first, then the file.** Files are never deleted inline; the sweep below removes them.
3. **Content-addressed keys** (`testdata/`, `staging/`, `packages/`) make retries harmless: the same bytes land on the same key.
4. **Verify hashes** where data crosses a boundary: the judge checks sources and packages; the API checks each answer against `build_done` before building the final package.
5. **Orphan sweep** (weekly background job): list each prefix and delete objects older than 24 h that no row references. The 24 h gap protects uploads still in progress.

## Backups and restore

Back up PostgreSQL and both buckets daily; restore the database first and keep the orphan sweep off until the restore is checked.

| What | How | Kept |
| --- | --- | --- |
| PostgreSQL | Nightly base backup + continuous WAL archiving for point-in-time recovery | 14 days (NFR-REL-03) |
| `assets`, `problems` buckets | Nightly incremental sync to a second location (another S3 target or disk); objects never change, so only new files copy | 14 days of daily snapshots |
| Redis | AOF only, no backup. After a loss, `flush_outbox` re-sends unsent jobs and `detect_delayed` flags anything left `queued` for staff to requeue | — |

Restore order:

1. Stop the API and the worker.
2. Restore PostgreSQL to the chosen time.
3. Restore both buckets from the same night or later. Extra newer files are harmless; missing files are not.
4. Start the API, check a problem page, a package build and an old submission's source, then re-enable the sweep job.

Run this once on staging before launch.
