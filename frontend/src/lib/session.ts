/**
 * Server-side session lookup, shared by `proxy.ts` and Server Components.
 * The session cookie is an opaque token, so it is checked by asking the
 * backend (`GET /auth/me`, normally one Redis lookup there).
 */

import type { User } from "@/lib/api";
import { BACKEND_URL } from "@/lib/backend";

// Must match the backend's SESSION_COOKIE_NAME
export const SESSION_COOKIE =
  process.env.SESSION_COOKIE_NAME ?? "flabsheet_session";

const SESSION_CHECK_TIMEOUT_MS = 3000;

export type SessionCheck =
  | { state: "valid"; user: User }
  | { state: "invalid" } // no token, or the backend rejected it
  | { state: "unknown" }; // the backend could not be asked

export async function checkSession(
  token: string | undefined,
): Promise<SessionCheck> {
  if (!token) return { state: "invalid" };
  try {
    const res = await fetch(`${BACKEND_URL}/auth/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
    });
    if (res.status === 401) return { state: "invalid" };
    if (!res.ok) return { state: "unknown" };
    const data = await res.json();
    if (!data?.user) return { state: "unknown" };
    return { state: "valid", user: data.user as User };
  } catch {
    return { state: "unknown" };
  }
}
