import { NextResponse, type NextRequest } from "next/server";

import { BACKEND_URL } from "@/lib/backend";
import { safeNextPath } from "@/lib/redirect";

/**
 * Authentication gate for every page. `/api/*` is excluded: those requests
 * are forwarded to the backend, which answers 401 itself.
 *
 * - no valid session            -> /login?next=<requested path>
 * - session must change password -> /change-password
 * - signed in and on /login      -> back into the app
 *
 * The session cookie is an opaque token, so validity is checked by asking the
 * backend (`GET /auth/me`, normally one Redis lookup there). This is a routing
 * convenience, not the security boundary: the backend authorizes every API
 * call itself.
 */

// Must match the backend's SESSION_COOKIE_NAME
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? "flabsheet_session";

const LOGIN_PATH = "/login";
const CHANGE_PASSWORD_PATH = "/change-password";
const SESSION_CHECK_TIMEOUT_MS = 3000;

type SessionCheck =
  | { state: "valid"; mustChangePassword: boolean }
  | { state: "invalid" } // the backend rejected the token
  | { state: "unknown" }; // the backend could not be asked

async function checkSession(token: string): Promise<SessionCheck> {
  try {
    const res = await fetch(`${BACKEND_URL}/auth/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
    });
    if (res.status === 401) return { state: "invalid" };
    if (!res.ok) return { state: "unknown" };
    const data = await res.json();
    return {
      state: "valid",
      mustChangePassword: Boolean(data?.user?.must_change_password),
    };
  } catch {
    return { state: "unknown" };
  }
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session: SessionCheck = token
    ? await checkSession(token)
    : { state: "invalid" };

  const redirectTo = (path: string) =>
    NextResponse.redirect(new URL(path, request.url));

  if (session.state === "valid") {
    if (session.mustChangePassword) {
      return pathname === CHANGE_PASSWORD_PATH
        ? NextResponse.next()
        : redirectTo(CHANGE_PASSWORD_PATH);
    }
    if (pathname === LOGIN_PATH) {
      return redirectTo(safeNextPath(request.nextUrl.searchParams.get("next")));
    }
    return NextResponse.next();
  }

  // Not signed in (or we cannot tell: fail closed).
  let response: NextResponse;
  if (pathname === LOGIN_PATH) {
    response = NextResponse.next();
  } else {
    const loginUrl = new URL(LOGIN_PATH, request.url);
    const next = pathname + search;
    if (next !== "/") loginUrl.searchParams.set("next", next);
    response = NextResponse.redirect(loginUrl);
  }
  // Drop a cookie the backend has rejected so we stop re-checking it.
  // Keep it when the backend was merely unreachable.
  if (token && session.state === "invalid") {
    response.cookies.delete(SESSION_COOKIE);
  }
  return response;
}

export const config = {
  matcher: [
    // Everything except /api, Next.js internals and static files
    "/((?!api/|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
