/**
 * Server-side access to the Flabsheet backend, used by the `/api/*` route
 * handlers and by `proxy.ts`. The browser never talks to the backend directly.
 */

export const BACKEND_URL = (
  process.env.BACKEND_URL ?? "http://localhost:8000"
).replace(/\/+$/, "");

const BACKEND_TIMEOUT_MS = 30_000;

// Request headers the backend needs; everything else (host, origin, ...) stays here.
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "cookie",
  "user-agent",
  "x-csrf-token",
  // Lets the backend see the real client IP (login rate limiting, audit log)
  "x-forwarded-for",
];

// Response headers that describe the backend connection, not the payload.
// fetch() has already decoded the body, so the encoding/length no longer apply.
const DROPPED_RESPONSE_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
];

/**
 * Send `request` on to the backend at `path` (e.g. "/auth/login") and return
 * its response, including Set-Cookie, so the session cookie is first-party.
 *
 * No auth check happens here: the backend authenticates and authorizes every
 * request itself (session cookie + X-CSRF-Token), and both are passed through.
 */
export async function forwardToBackend(
  request: Request,
  path: string,
): Promise<Response> {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetch(BACKEND_URL + path + new URL(request.url).search, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
  } catch {
    return Response.json(
      { detail: "The server is unavailable. Please try again." },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers(upstream.headers); // keeps each Set-Cookie
  for (const name of DROPPED_RESPONSE_HEADERS) responseHeaders.delete(name);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
