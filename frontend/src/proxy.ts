import { NextResponse, type NextRequest } from "next/server";

import { canAccessPath } from "@/lib/navigation";
import {
  LOGIN_REASON_PARAM,
  LOGIN_REASON_UNAVAILABLE,
  safeNextPath,
  withNext,
} from "@/lib/redirect";
import { checkSession, SESSION_COOKIE } from "@/lib/session";

/**
 * Authentication gate for every page. `/api/*` is excluded: those requests
 * are forwarded to the backend, which answers 401 itself.
 *
 * - no valid session on /       -> through: app/page.tsx shows the landing page
 * - no valid session elsewhere   -> /login?next=<requested path>
 * - backend could not be asked   -> same, plus ?reason=unavailable on /login
 * - session must change password -> /change-password?next=<requested path>
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
      if (pathname === CHANGE_PASSWORD_PATH) return NextResponse.next();
      // Carry the page they wanted through the password change
      const next =
        pathname === LOGIN_PATH
          ? request.nextUrl.searchParams.get("next")
          : pathname + search;
      return redirectTo(withNext(CHANGE_PASSWORD_PATH, next));
    }
    if (pathname === LOGIN_PATH) {
      const next = safeNextPath(request.nextUrl.searchParams.get("next"));
      return redirectTo(canAccessPath(next, session.user.role) ? next : "/");
    }
    if (!canAccessPath(pathname, session.user.role)) return redirectTo("/");
    return NextResponse.next();
  }

  // Not signed in (or we cannot tell: fail closed).
  // When we cannot tell, /login carries ?reason=unavailable so the page can
  // say the server is slow instead of looking like the session was lost
  // (signing in again would only bounce back here). Only proxy.ts sets or
  // clears it, so a stale copy in the URL never outlives the outage.
  const unavailable = session.state === "unknown";
  let response: NextResponse;
  if (pathname === LOGIN_PATH) {
    const params = request.nextUrl.searchParams;
    const tagged =
      params.get(LOGIN_REASON_PARAM) === LOGIN_REASON_UNAVAILABLE;
    if (unavailable === tagged) {
      response = NextResponse.next();
    } else {
      const url = request.nextUrl.clone();
      if (unavailable) {
        url.searchParams.set(LOGIN_REASON_PARAM, LOGIN_REASON_UNAVAILABLE);
      } else {
        url.searchParams.delete(LOGIN_REASON_PARAM);
      }
      response = NextResponse.redirect(url);
    }
  } else if (pathname === "/") {
    // Public: the page itself shows the landing page to signed-out visitors.
    // Not a rewrite to a separate route: see the comment in app/page.tsx.
    response = NextResponse.next();
  } else {
    const loginUrl = new URL(LOGIN_PATH, request.url);
    const next = pathname + search;
    if (next !== "/") loginUrl.searchParams.set("next", next);
    if (unavailable) {
      loginUrl.searchParams.set(LOGIN_REASON_PARAM, LOGIN_REASON_UNAVAILABLE);
    }
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
    // Everything except /api, Next.js internals, static files and the link
    // preview image (fetched by signed-out crawlers)
    "/((?!api/|_next/static|_next/image|favicon\\.ico|opengraph-image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
