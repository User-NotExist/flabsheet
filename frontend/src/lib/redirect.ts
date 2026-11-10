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
