# Frontend implementation

The frontend is one Next.js app on Bun that serves all three roles; it holds no business rules and calls the FastAPI backend for everything, so access control and hidden-data rules live server-side.

Login, change password, the top navigation, the auth gate, the staff problem pages (`/manage/problems`, `/new`, `/[id]`), student management and the solving pages (`/problems`, `/problems/[slug]`, `/submissions/[id]`) exist today. The rest of this page is the plan. Every page fetches with plain effects and `lib/api.ts` (see Stack and setup), and the problem editor reorders test cases with buttons instead of drag and drop; `/new` asks only for title and slug, because images and test inputs need the problem's id. [frontend/AGENTS.md](../frontend/AGENTS.md) holds the day-to-day coding rules.

## Stack and setup

Use the App Router with server components for read-only pages and client components only where there is interaction (editors, live status, toggles).

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16 App Router, TypeScript strict, run and built with Bun |
| UI | shadcn/ui components (built on Base UI, not Radix) on Tailwind CSS v4; `next-themes` for light/dark (NFR-UX-01) |
| Server data | Plain effects in client components calling the typed functions in `lib/api.ts`, with `useApiError` for failures; no query library. After a change the component sets its own state from the response or fetches again. Plain `fetch` in server components |
| Forms | Controlled inputs with component state and hand-written validation; no form library. The backend validates again and its `detail` message is shown |
| API types | Hand-written in `src/lib/api.ts`, mirroring the backend's Pydantic models (snake_case fields). Change both sides together |
| Code editor | React CodeMirror (`@uiw/react-codemirror`, CodeMirror 6) with `@codemirror/lang-cpp` and `@codemirror/lang-python` |
| Markdown | `react-markdown` + `remark-gfm` + `remark-math`/`rehype-katex` + `rehype-sanitize` + Shiki highlighting; raw HTML off (NFR-SEC-03) |
| Tables | Plain `<table>` markup styled with Tailwind; no table library |
| Tests | Deferred until after the MVP. Planned: Vitest + Testing Library for components; Playwright for end-to-end flows. Until then a change is done when `bun run lint` and `bunx tsc --noEmit` pass and the page was checked in the running app |

Layout under `frontend/src/` (pages marked *planned* do not exist yet):

```
proxy.ts                      session check and role routing (Next 16 "proxy", formerly middleware)
app/login, app/change-password    signed-out / account pages
app/(app)/                    signed-in pages, one layout with the top nav
  manage/problems, manage/problems/[id], manage/problems/new, manage/students
  problems, problems/[slug], submissions/[id]
  planned: leaderboard, manage/progress, manage/submissions, manage/leaderboard, admin/staff, admin/settings
app/api/<path>/route.ts       thin forwarders to the backend (forwardToBackend)
components/ui/                shadcn primitives
components/<feature>/         feature components (section below)
lib/api.ts                    browser client, ApiError, CSRF handling, hand-written types
lib/backend.ts                server-only forwarder
lib/navigation.ts             NAV_ITEMS: nav links and which role may open which section
lib/sse.ts                    useSubmissionProgress: submission status stream hook
lib/drafts.ts                 code drafts in localStorage, per user, problem and language
```

There are no per-role route groups. Which role may open a page is decided by its `NAV_ITEMS` entry, which `proxy.ts` enforces for navigation (the backend enforces it for data).

## Pages

Fifteen routes cover the MVP; staff pages are also available to admin.

| Route | Role | What it does | Covers |
| --- | --- | --- | --- |
| `/login` | All | ID + password form, generic error on failure, rate-limit message | FR-AUTH-01, 08 |
| `/change-password` | All | Change own password; forced on first login when `must_change_password` is set, and then without the current-password field | FR-AUTH-06, 07 |
| `/problems` | Student | Enabled problems with max points, current score and status badge (not attempted / attempted / solved) | FR-STD-01 |
| `/problems/[slug]` | Student | Rendered statement, limits, languages, sample cases; split view with code editor, language picker, Submit, live status, result report, own history | FR-STD-04–09, FR-ADM-05 banner |
| `/submissions/[id]` | Student (own), staff | Full result report; staff view adds source, hidden-case results and compiler log | FR-STD-08, FR-MON-02 |
| `/leaderboard` | Student | Rank, display name, total, solved count, own row highlighted; "hidden" and "frozen at …" states | FR-STD-02, 03, FR-MON-07 |
| `/manage/problems` | Staff | All problems: status, build status, languages, submission count; enable/disable toggle (disabled with reason until build is ok) | FR-PRB-01–03 |
| `/manage/problems/new`, `/manage/problems/[id]` | Staff | Problem editor (statement, settings, reference solution, test cases tabs), build panel, student preview, delete/archive, rejudge | FR-PRB-04–17 |
| `/manage/students` | Staff | Search, create one, CSV import, edit name, deactivate, reset password (password shown once) | FR-STU-01–06 |
| `/manage/progress` | Staff | Students × problems matrix, scores CSV export | FR-MON-01, 04 |
| `/manage/submissions` | Staff | Filterable submission list, JE review queue, requeue delayed, raw CSV export | FR-MON-02, 03, 05, 06, FR-JDG-05 |
| `/manage/leaderboard` | Staff | Live leaderboard + Live / Hidden / Frozen control | FR-MON-07 |
| `/admin/staff` | Admin | Create, edit, deactivate staff; reset password | FR-ADM-01–04 |
| `/admin/settings` | Admin | Submission killswitch with banner message | FR-ADM-05 |

## Shared components

Build these once and reuse them; the student view and the staff preview must render through the same components so they match (FR-PRB-05, FR-PRB-14).

| Component | Used on | Behaviour |
| --- | --- | --- |
| `MarkdownView` | Problem page, editor preview, hints | GFM, KaTeX math, highlighted code, images from the API; sanitized, no raw HTML |
| `MarkdownEditor` | Problem editor | Split edit/preview, image paste and drag-drop upload that inserts `![](url)`, 5 MB and type check before upload |
| `TestCaseEditor` | Problem editor | Ordered list with drag reorder; input by typing or `.in` upload; visibility select (hidden / visible / sample); optional hint; expected output and reference time shown after build (staff only) |
| `BuildStatusPanel` | Problem editor, problem list | Pending / ok / failed; on failure the failing test case, reason and log; warning when reference time is over 50% of the limit |
| `CodeEditor` | Problem page, problem editor | React CodeMirror with language from the allowed list. On the problem page the page keeps one draft per user, problem and language in `localStorage` (`lib/drafts.ts`; the user id is in the key because lab computers are shared) and shows the 64 KB counter |
| Submit button (part of `SolvePage`) | Problem page | Disabled with reason when the killswitch is on, the code is empty or over 64 KB, the 10 s rate limit applies or 3 jobs are queued; asks before replacing a full current score (FR-STD-06) |
| `LiveStatus` | Problem page, submission page | Queued → compiling → running test n of m → done, drawn from the progress that `useSubmissionProgress` delivers (SSE, with polling every 3 s if the stream keeps failing) |
| `VerdictBadge` | Everywhere a verdict shows | Text label + colour for all 11 verdicts, tooltip with the plain-language meaning (NFR-UX-03) |
| `ResultReport` | Problem page, submission page | `layout="table"`: per-test table (verdict, time, memory), then the details of failed tests. `layout="cards"`: every test with its details. Details are input, expected and student output for sample/visible cases; hint on failure; compiler log on CE; PE message on sample/visible cases, the PE label and its explanation alone on hidden ones |
| `WhitespaceText`, `WhitespaceToggle` | `ResultReport`, sample cases | Renders text with · → ↵ markers; on by default for Strict problems, toggle to hide |
| `CsvImportDialog` | Students page | Upload, client-side preview, server validation report by row, then one-time download of the password CSV |
| `OneTimeSecret` | Password reset, staff create, CSV import | Shows a generated password once with copy button and "I have saved it" confirm |
| `ServerClock` | Top bar | The server's date and time in the server's time zone: reads `GET /settings/time`, counts on locally and re-syncs every 5 min |
| `KillswitchBanner`, `InstanceSettingsProvider` | All signed-in layouts | The provider reads `GET /settings` every 30 s and `useInstanceSettings()` hands it to pages; the banner shows the admin message while submissions are closed |

## Auth, data and live updates

The frontend trusts the session cookie and the API's answers; it never decides on its own what a role may see.

- **Session:** the backend sets an HTTP-only cookie. `src/proxy.ts` calls `GET /auth/me` on every page request and redirects: signed out → `/login?next=…`, `must_change_password` → `/change-password`, role not allowed by the page's `NAV_ITEMS` entry → `/`. This is for navigation only; the API enforces access (FR-AUTH-03).
- **Backend calls:** the browser only calls `/api/*` on this app. Each backend endpoint needs a route handler under `app/api/` that calls `forwardToBackend`, and a typed function in `lib/api.ts`.
- **CSRF:** every state-changing request sends the CSRF token the backend issues in `X-CSRF-Token`; `lib/api.ts` adds it automatically.
- **Fetching:** client components fetch in an effect (guarded by a `cancelled` flag) through `lib/api.ts` and keep the result in state; after a change they set that state from the response or fetch again (for example, a final verdict reloads the report, the history and the current score). The router keeps left pages mounted but hidden and re-runs their effects when they are shown again, so a page is fresh each time it is opened. Server components may fetch read-only data with the user's cookie forwarded.
- **Live status:** `useSubmissionProgress(id, onProgress)` (`lib/sse.ts`) opens `EventSource` on `/api/submissions/{id}/stream`. That route handler must call `forwardToBackend(request, path, { stream: true })`, because the default 30 s timeout would cut the stream. Each message is a whole snapshot `{id, status, tests_done, verdict, score_milli}` with no test data; the hook passes it to the page, closes on a final status, and switches to 3 s polling after two failures in a row (NFR-PERF-04). The page fetches the report once the status is final.
- **Build status:** the problem editor polls the problem every 2 s while its build is pending.
- **Settings:** `GET /settings` is fetched by `InstanceSettingsProvider` in the signed-in layout and refreshed every 30 s, so the killswitch banner and leaderboard mode appear without a reload. Problem pages call its `refresh` every 5 s, so the Submit button comes back within the 5 s that FR-ADM-05 requires.
- **Errors:** every API error has a `detail` sentence, which the UI shows as is. Some also have a `code` (`ApiError.code`): `submissions_closed`, `rate_limited`, `language_not_allowed`, `problem_disabled`, `csv_invalid`. Branch on `code` or the HTTP status, never on the text of `detail`. Never show raw status codes or stack traces.
- **Times and units:** show dates in the viewer's timezone (NFR-UX-04), scores as `score_milli / 1000` with 2 decimals (FR-JDG-03).

## Definition of done

- [ ] Page works in light and dark theme, keyboard only, and at 375 px width (editor may scroll)
- [ ] Loading, empty and error states designed, not blank
- [ ] Types in `lib/api.ts` match the backend's Pydantic models; `bun run lint` and `bunx tsc --noEmit` pass
- [ ] No hidden test data rendered even if the API returned it by mistake (`ResultReport` ignores output fields on hidden cases)
- [ ] Main path checked by hand in the running app. Automated tests (component tests, Playwright for submit-to-verdict, create-build-enable, CSV import, killswitch) are deferred until after the MVP
