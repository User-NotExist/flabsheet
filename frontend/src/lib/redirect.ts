/**
 * Redirect helpers shared by `proxy.ts` and the auth forms.
 *
 *     safeNextPath(params.get("next"))        // "/problems", or "/" if unsafe
 *     withNext("/change-password", "/problems") // "/change-password?next=%2Fproblems"
 */

/**
 * Query parameter `proxy.ts` adds to /login when it could not ask the backend
 * whether the session is valid, so the page can say why the user is there.
 */
export const LOGIN_REASON_PARAM = "reason";
export const LOGIN_REASON_UNAVAILABLE = "unavailable";

/**
 * Return `value` if it is a same-origin path we can safely redirect to,
 * otherwise `fallback`. Rejects absolute and protocol-relative URLs so a
 * crafted `?next=` cannot send a user to another site after login.
 */
export function safeNextPath(
  value: string | null | undefined,
  fallback = "/",
): string {
  if (!value || !value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.includes("\\")) return fallback;
  return value;
}

/** `path` with `?next=` set, or `path` alone when `next` is "/" or unsafe. */
export function withNext(path: string, next: string | null | undefined): string {
  const safe = safeNextPath(next);
  return safe === "/" ? path : `${path}?next=${encodeURIComponent(safe)}`;
}
