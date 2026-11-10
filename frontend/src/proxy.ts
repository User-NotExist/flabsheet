import { NextResponse, type NextRequest } from "next/server";

import { canAccessPath } from "@/lib/navigation";
import { safeNextPath } from "@/lib/redirect";
import { checkSession, SESSION_COOKIE } from "@/lib/session";

/**
 * Authentication gate for every page. `/api/*` is excluded: those requests
 * are forwarded to the backend, which answers 401 itself.
 *
 * - no valid session            -> /login?next=<requested path>
 * - session must change password -> /change-password
 * - signed in and on /login      -> back into the app
 * - role may not open the page   -> / (see NAV_ITEMS in lib/navigation.ts)
 *
 * The session cookie is an opaque token, so validity is checked by asking the
 * backend (`GET /auth/me`, normally one Redis lookup there). This is a routing
 * convenience, not the security boundary: the backend authorizes every API
 * call itself.
 */

const LOGIN_PATH = "/login";
const CHANGE_PASSWORD_PATH = "/change-password";

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await checkSession(token);

  const redirectTo = (path: string) =>
    NextResponse.redirect(new URL(path, request.url));

  if (session.state === "valid") {
    if (session.user.must_change_password) {
      return pathname === CHANGE_PASSWORD_PATH
        ? NextResponse.next()
        : redirectTo(CHANGE_PASSWORD_PATH);
    }
    if (pathname === LOGIN_PATH) {
      const next = safeNextPath(request.nextUrl.searchParams.get("next"));
      return redirectTo(canAccessPath(next, session.user.role) ? next : "/");
    }
    if (!canAccessPath(pathname, session.user.role)) return redirectTo("/");
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
