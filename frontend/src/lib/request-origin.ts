/**
 * The public origin of the current request, for metadata that needs absolute
 * URLs (the link preview card's og:image). Server-only.
 *
 *   const origin = await requestOrigin(); // URL("https://flabsheet.example") or undefined
 *
 * Read per request instead of from a setting, so the same build works behind
 * any host name. Reading headers makes metadata request-time; see layout.tsx.
 */

import { headers } from "next/headers";

// A host name or IPv4 address, or a bracketed IPv6 address, with an optional
// port. Anything else (a header with a path, spaces, credentials) is refused
// so a crafted Host can't turn the og:image URL into something odd.
const HOST_RE = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** First value of a comma-separated forwarded header ("a, b" from proxy chains) */
function first(value: string | null): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

export async function requestOrigin(): Promise<URL | undefined> {
  const h = await headers();
  // A reverse proxy in front of Next.js sets X-Forwarded-*; Next.js fills them
  // in from the socket when they are missing.
  const host = first(h.get("x-forwarded-host")) ?? first(h.get("host"));
  const proto = first(h.get("x-forwarded-proto")) === "https" ? "https" : "http";
  if (!host || !HOST_RE.test(host)) return undefined;
  return new URL(`${proto}://${host}`);
}
