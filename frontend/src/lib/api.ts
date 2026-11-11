/**
 * Browser-side client for the Flabsheet backend auth API.
 *
 * Requests go to this app's own `/api/auth/*` route handlers, which forward them
 * to the backend. The session lives in an HttpOnly cookie; state-changing
 * calls must also carry the session's CSRF token, which the backend hands out
 * on login and `GET /auth/me`.
 */

const API_URL = "/api";

export const MIN_PASSWORD_LENGTH = 8; // same rule as the backend

export type UserRole = "student" | "staff" | "admin";

export type User = {
  id: number;
  login_id: string;
  display_name: string;
  role: UserRole;
  must_change_password: boolean;
};

type AuthResponse = { user: User; csrf_token: string };

export class ApiError extends Error {
  constructor(
    /** HTTP status, or 0 when the backend could not be reached. */
    readonly status: number,
    message: string,
    /** Seconds to wait before retrying (429 responses). */
    readonly retryAfter?: number,
    /**
     * Machine-readable error code (e.g. "rate_limited"), set only on errors
     * the UI has to tell apart. Branch on this, never on the message.
     */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken: string | null = null;

async function errorBody(
  res: Response,
): Promise<{ message: string; code?: string }> {
  let body: { detail?: unknown; code?: unknown } | null = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  const code = typeof body?.code === "string" ? body.code : undefined;
  // FastAPI: a string for HTTPException, a list for validation errors
  if (typeof body?.detail === "string") return { message: body.detail, code };
  const message =
    res.status === 422
      ? "Some of the values entered are not valid."
      : `Request failed (${res.status}).`;
  return { message, code };
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, init);
  } catch {
    throw new ApiError(0, "Cannot reach the server. Please try again.");
  }
  if (!res.ok) {
    const retryAfter = Number(res.headers.get("Retry-After")) || undefined;
    const { message, code } = await errorBody(res);
    throw new ApiError(res.status, message, retryAfter, code);
  }
  return res;
}

/** POST with the CSRF header, fetching the token first if we don't have it. */
async function post(path: string, body?: unknown): Promise<Response> {
  if (!csrfToken) await getSession();
  return request(path, {
    method: "POST",
    headers: {
      "X-CSRF-Token": csrfToken ?? "",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function login(loginId: string, password: string): Promise<User> {
  const res = await request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login_id: loginId, password }),
  });
  const data: AuthResponse = await res.json();
  csrfToken = data.csrf_token;
  return data.user;
}

/** The signed-in user. Throws ApiError(401) when there is no valid session. */
export async function getSession(): Promise<User> {
  const res = await request("/auth/me");
  const data: AuthResponse = await res.json();
  csrfToken = data.csrf_token;
  return data.user;
}

export async function logout(): Promise<void> {
  await post("/auth/logout");
  csrfToken = null;
}

/** Changes the password; the backend signs out the user's other sessions. */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await post("/auth/change-password", {
    current_password: currentPassword,
    new_password: newPassword,
  });
}
