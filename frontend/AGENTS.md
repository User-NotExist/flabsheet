<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md — frontend

**Never read `frontend/.env`.** Use `.env.example` to see which settings exist. Also read the root [AGENTS.md](../AGENTS.md). Leave the block above exactly as it is: `next dev` regenerates it.

Next.js **16.4** App Router with React 19.3, TypeScript (strict), Tailwind CSS v4 and shadcn/ui (`base-nova` style, built on **Base UI**, not Radix). The package manager is **bun**. `next.config.ts` turns on `cacheComponents`, `partialPrefetching` and `output: "standalone"`.

## Commands

```sh
bun install
bun run dev              # http://localhost:3000 (backend expected at BACKEND_URL, default http://localhost:8000)
bun run lint             # eslint (next core-web-vitals + typescript), must be clean
bunx tsc --noEmit        # typecheck, must be clean
bun run build            # production build; run it when you touch routing, config or caching
bunx shadcn@latest add <component>   # add a ui component (see the shadcn skill in ../.agents/skills/shadcn)
```

No tests exist yet. A change is done when `lint` and `tsc` pass. For UI changes, also check the page in the running app.

## Layout

```
src/proxy.ts                 auth gate for every page (Next 16 "proxy", formerly middleware); /api excluded
src/app/layout.tsx           root layout, Geist fonts, metadata template "%s · Flabsheet"
src/app/(app)/               signed-in pages; layout.tsx renders <TopNav/> inside <Suspense>
src/app/login, change-password   signed-out/account pages (wrapped in <AuthShell>, no top nav)
src/app/api/<path>/route.ts  thin forwarders: `return forwardToBackend(request, "/<path>")`
src/components/ui/           shadcn-generated primitives (badge, button, card, dialog, input, label, native-select,
                             switch, tabs, textarea)
src/components/<feature>/    feature components (auth/, nav/, problems/, students/, solve/, submissions/, settings/)
src/app/(app)/manage/problems  staff problem list, /new (title + slug), /[id] (editor)
src/app/(app)/problems       /problems (list with own scores), /[slug] (statement, editor, submit, live result, history;
                             staff see it as a preview)
src/app/(app)/submissions/[id]  one result report (student: own; staff: anyone's, with hidden-case details)
src/lib/api.ts               browser client: fetch /api/*, ApiError, CSRF token handling, shared types
src/lib/backend.ts           server-only: BACKEND_URL, forwardToBackend (header allowlist)
src/lib/session.ts           server-only: checkSession(token) → valid | invalid | unknown
src/lib/navigation.ts        NAV_ITEMS (+ roles), canAccessPath, navItemsFor, isActive, ROLE_LABELS
src/lib/redirect.ts          safeNextPath(): open-redirect guard for ?next=
src/lib/use-api-error.ts     useApiError(): error → message to show, redirecting to /login on 401
src/lib/sse.ts               useSubmissionProgress(): live judging status over SSE, polling if the stream fails
src/lib/drafts.ts            code drafts in localStorage, keyed by user, problem and language
```

## How auth works here

- The browser calls `@/lib/api` functions, which hit `/api/*` on this app. Route handlers forward to the backend. The backend's `Set-Cookie` passes through, so the HttpOnly session cookie is first-party.
- `src/proxy.ts` checks the cookie with `GET /auth/me` on every page request. It redirects to `/login?next=…`, forces `/change-password`, and sends roles not allowed in `NAV_ITEMS` back to `/`. When the backend can't be reached (`unknown`), it fails closed but keeps the cookie.
- These are UX checks. The backend authorizes for real.
- POSTs need the CSRF token. `post()` in `lib/api.ts` fetches it through `getSession()` when needed. Add new mutating calls as functions in `lib/api.ts` that use `post()`, and don't call `fetch` from components.
- Always pass user-supplied redirect targets through `safeNextPath`.

## Adding things

- **Page**: create `src/app/(app)/<route>/page.tsx` with a default export and `export const metadata: Metadata = { title: "…" }`. If only some roles should see it, add or adjust its `NAV_ITEMS` entry; that one entry controls both the nav link and proxy access for everything below the path. An `hrefByRole` target (such as `/manage/problems`) is a section too: only the roles mapped to it may open pages below it.
- **Backend call**: add the route handler under `src/app/api/...` (one exported function per method), then add a typed wrapper in `lib/api.ts` with snake_case fields matching the backend Pydantic models. For a path with an id, use `forwardWithId` (it refuses anything but digits, so a segment like `..` cannot reach another backend route); for a problem slug, `forwardWithSlug`. For a long-lived response (SSE), pass `{ stream: true }` to `forwardToBackend`, or its 30 s timeout cuts the stream.
- **Server-only data**: Server Components can read the session with `cookies()` + `checkSession()` (see `top-nav.tsx`). With `cacheComponents`, anything that reads cookies or headers must render inside a `<Suspense>` boundary with a fallback that matches the layout.

## Gotchas

- **Hidden pages stay mounted.** With `cacheComponents` the router keeps pages and layouts you navigated away from mounted but hidden, so their state comes back when you return. Client components with pending or error state reset it in a `useLayoutEffect` cleanup. Auth forms clear typed passwords with the stable `resetOnDetach` callback ref so visible fields survive re-renders.
- **Global type helpers**: `LayoutProps<"/">` / `PageProps<"/route">` are generated by Next and don't need an import.
- **`cn`** comes from the `cn` package (`@/lib/utils` re-exports it), not clsx + tailwind-merge.
- **Base UI APIs**: these differ from Radix. There is no `asChild`. To style a link as a button, use `className={buttonVariants({ variant, size })}` on `<Link>`.
- **Error codes**: some backend errors carry a `code`, exposed as `ApiError.code` (for example `rate_limited`). Branch on the code or the status, never on the message text.
- **Effects that fetch**: guard them with a `cancelled` flag in the cleanup, and handle `ApiError` with status 401 by redirecting with `router.replace("/login…")` (`useApiError` does this). Call `setState` only in the promise callbacks: the lint rules reject it in the effect body, and reject reading or writing a ref during render.
- **Dynamic route params in a Client Component**: read them with `useParams()` and render the component inside `<Suspense>` in the page (see `manage/problems/[id]/page.tsx`).
- **Markdown**: render it only through `components/problems/markdown-view.tsx` (sanitised, no raw HTML, KaTeX), so previews and student views match.
- **Data fetching**: there is no query library. Fetch in an effect through `lib/api.ts`, keep the result in state, and after a change set that state from the response or fetch again. A hidden page re-runs its effects when it is shown again, which is what keeps scores and history fresh.
- **Client providers in `(app)/layout.tsx` go beside `<TopNav />`, not around it**: wrapped in a client component, its session lookup fails the dev prerender check ("unstable value `Date.now()`").
- **Results and verdicts**: draw them with `components/submissions/` (`VerdictBadge`, `ResultReport`, `LiveStatus`, `WhitespaceText`, `format.ts`), so the problem page, the submission page and the staff preview cannot drift apart. `ResultReport` hides a hidden test's data from students even if a response carried it.
- **Instance settings**: read them with `useInstanceSettings()` (killswitch, leaderboard mode); don't fetch `/api/settings` again in a page.

## Style

- Use double quotes and semicolons, 2-space indent, and trailing commas in multiline lists. Files in `components/ui/` are shadcn-generated (no semicolons). Leave their formatting alone.
- Order imports as: framework/external packages, blank line, then `@/` aliases (alphabetical). Use `import type` / inline `type` for types. Always use the `@/` alias, never relative `../`.
- Name files in kebab-case (`change-password-form.tsx`). Components are named exports in PascalCase, and only `page`/`layout`/route files use default exports.
- Add `"use client"` only to components that need state, effects or browser APIs. Keep pages and layouts as Server Components.
- Give each `lib/` module a JSDoc header explaining its role, and comment non-obvious decisions. Comments explain why, not what.
- Styling:
  - Use Tailwind utilities with the theme tokens in `globals.css` (`bg-primary`, `text-muted-foreground`, `text-destructive`, `bg-warning`/`text-warning-foreground`). Don't hard-code colors.
  - Add new tokens to both `:root` and `.dark`, plus `@theme inline`.
  - Primary is green (`oklch(52% 0.15 144)`).
- UI copy:
  - Write short, sentence-case messages that end with a period.
  - Use the real ellipsis `…` in pending labels ("Signing in…").
  - Show errors with `<FormError message={…} />` (`role="alert"`).
  - Messages are user-facing, so never show raw status codes or stack traces.
- Accessibility: every input has a `<Label htmlFor>`, along with the right `autoComplete`; active nav links get `aria-current="page"`; status messages use `role="status"`.
