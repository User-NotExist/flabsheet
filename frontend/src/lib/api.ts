/**
 * Browser-side client for the Flabsheet backend API.
 *
 * Requests go to this app's own `/api/*` route handlers, which forward them
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

/**
 * A state-changing request with the CSRF header, fetching the token first if
 * we don't have it. `body` is sent as JSON, or as is when it is a FormData
 * (the browser then sets the multipart Content-Type itself).
 */
async function send(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Response> {
  if (!csrfToken) await getSession();
  const isForm = body instanceof FormData;
  return request(path, {
    method,
    headers: {
      "X-CSRF-Token": csrfToken ?? "",
      ...(body === undefined || isForm
        ? {}
        : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
}

function post(path: string, body?: unknown): Promise<Response> {
  return send("POST", path, body);
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

export type Student = Pick<User, "id" | "login_id" | "display_name"> & {
  is_active: boolean;
};

export type StudentCredential = { student: Student; password: string };

export async function listStudents(): Promise<Student[]> {
  return (await request("/students")).json();
}

export async function createStudent(studentId: string, displayName: string): Promise<StudentCredential> {
  return (await post("/students", { student_id: studentId, display_name: displayName })).json();
}

export async function updateStudent(
  id: number,
  update: Partial<Pick<Student, "display_name" | "is_active">>,
): Promise<Student> {
  return (await send("PATCH", `/students/${id}`, update)).json();
}

export async function resetStudentPassword(id: number): Promise<StudentCredential> {
  return (await post(`/students/${id}/reset-password`)).json();
}

export async function importStudents(file: File): Promise<Blob> {
  const data = new FormData();
  data.append("file", file);
  return (await post("/students/import", data)).blob();
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

// --- Problem management (staff, admin) -------------------------------------
// Types mirror the Pydantic models in backend/routers/problems.py.

export const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/; // same rule as the backend
export const MAX_TEST_CASES = 100;
export const MAX_TEST_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_HINT_LENGTH = 1000;
export const MAX_SOURCE_BYTES = 64 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export type ProblemStatus = "draft" | "enabled" | "disabled" | "archived";
export type BuildStatus = "pending" | "ok" | "failed";
export type TestCaseVisibility = "hidden" | "visible" | "sample";

export type Language = { id: string; display: string };

export type ProblemListItem = {
  id: number;
  slug: string;
  title: string;
  status: ProblemStatus;
  /** Build of the newest version; null while the problem has no version. */
  build_status: BuildStatus | null;
  can_enable: boolean;
  languages: string[];
  submission_count: number;
  updated_at: string;
};

export type LanguageLimit = {
  language_id: string;
  /** null = the version's time limit. */
  time_limit_ms: number | null;
};

export type Build = {
  status: BuildStatus;
  reason: string | null;
  failed_testcase: string | null;
  log: string | null;
  max_ref_time_ms: number | null;
};

export type TestCase = {
  id: number;
  ordinal: number;
  input_sha256: string;
  input_bytes: number;
  input_preview: string;
  input_truncated: boolean;
  /** Expected output, known once the build succeeded. */
  answer_preview: string | null;
  answer_truncated: boolean;
  visibility: TestCaseVisibility;
  hint_md: string | null;
  ref_time_ms: number | null;
};

export type ProblemVersion = {
  id: number;
  version: number;
  max_points: number;
  time_limit_ms: number;
  memory_limit_mb: number;
  checker_strict: boolean;
  float_abs: number | null;
  float_rel: number | null;
  languages: LanguageLimit[];
  reference_language: string;
  reference_source: string;
  build: Build;
  test_cases: TestCase[];
};

export type ProblemDetail = {
  id: number;
  slug: string;
  title: string;
  statement_md: string;
  status: ProblemStatus;
  can_enable: boolean;
  /** Number of the version students are judged against, if any. */
  current_version: number | null;
  student_submission_count: number;
  updated_at: string;
  /** The newest version: what the editor edits. */
  version: ProblemVersion | null;
};

export type BuildState = {
  status: ProblemStatus;
  can_enable: boolean;
  current_version: number | null;
  version: number | null;
  build: Build | null;
};

export type TestData = {
  sha256: string;
  bytes: number;
  preview: string;
  truncated: boolean;
};

/** The versioned part of a problem, always sent whole. */
export type ProblemConfig = {
  max_points: number;
  time_limit_ms: number;
  memory_limit_mb: number;
  checker_strict: boolean;
  float_abs: number | null;
  float_rel: number | null;
  languages: LanguageLimit[];
  reference_language: string;
  reference_source: string;
  test_cases: {
    input_sha256: string;
    visibility: TestCaseVisibility;
    hint_md: string | null;
  }[];
};

export type ProblemUpdate = {
  title?: string;
  slug?: string;
  statement_md?: string;
  config?: ProblemConfig;
};

export async function listLanguages(): Promise<Language[]> {
  return (await request("/admin/languages")).json();
}

export async function listProblems(): Promise<ProblemListItem[]> {
  return (await request("/admin/problems")).json();
}

export async function createProblem(
  title: string,
  slug: string,
): Promise<ProblemDetail> {
  return (await post("/admin/problems", { title, slug })).json();
}

export async function getProblem(id: number): Promise<ProblemDetail> {
  return (await request(`/admin/problems/${id}`)).json();
}

/**
 * Saves the editor. The backend creates a new version and starts a build
 * only when `config` changes how submissions are judged.
 */
export async function updateProblem(
  id: number,
  update: ProblemUpdate,
): Promise<ProblemDetail> {
  return (await send("PATCH", `/admin/problems/${id}`, update)).json();
}

export async function deleteProblem(id: number): Promise<void> {
  await send("DELETE", `/admin/problems/${id}`);
}

export async function setProblemState(
  id: number,
  action: "enable" | "disable" | "archive",
): Promise<ProblemDetail> {
  return (await post(`/admin/problems/${id}/${action}`)).json();
}

/** Build state only: cheap enough to poll while a build is pending. */
export async function getBuildState(id: number): Promise<BuildState> {
  return (await request(`/admin/problems/${id}/build`)).json();
}

export async function rebuildProblem(id: number): Promise<ProblemDetail> {
  return (await post(`/admin/problems/${id}/build`)).json();
}

/** Stores one test input; a later save refers to it by the returned hash. */
export async function uploadTestData(id: number, file: Blob): Promise<TestData> {
  const form = new FormData();
  form.append("file", file);
  return (await post(`/admin/problems/${id}/testdata`, form)).json();
}

/** Stores a statement image and returns the URL to link in the Markdown. */
export async function uploadImage(id: number, file: Blob): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const image: { id: number } = await (
    await post(`/admin/problems/${id}/images`, form)
  ).json();
  return `${API_URL}/images/${image.id}`;
}

// --- Instance settings ------------------------------------------------------
// Mirrors backend/routers/settings.py.

export type InstanceSettings = {
  /** False while the admin's killswitch is on: nobody can submit. */
  submissions_open: boolean;
  submissions_message: string | null;
  leaderboard_mode: "live" | "frozen" | "hidden";
};

export async function getInstanceSettings(): Promise<InstanceSettings> {
  return (await request("/settings")).json();
}

// --- Solving problems (every role) -----------------------------------------
// Types mirror the Pydantic models in backend/routers/solve.py.

export type SolveState = "not_attempted" | "attempted" | "solved";

export type SolveListItem = {
  slug: string;
  title: string;
  max_points: number;
  languages: Language[];
  /** The viewer's current score; null before the first scored result. */
  score_milli: number | null;
  state: SolveState;
};

export type SolveLanguage = Language & { time_limit_ms: number };

export type SampleCase = {
  ordinal: number;
  input: string;
  input_truncated: boolean;
  expected: string;
  expected_truncated: boolean;
};

export type SolveProblem = {
  id: number;
  slug: string;
  title: string;
  statement_md: string;
  status: ProblemStatus;
  max_points: number;
  memory_limit_mb: number;
  checker_strict: boolean;
  languages: SolveLanguage[];
  samples: SampleCase[];
  score_milli: number | null;
  /** True for staff and admins: their submissions are tests, never ranked. */
  preview: boolean;
  /** Staff and admins only. */
  reference: { language_id: string; source: string } | null;
};

export async function listSolveProblems(): Promise<SolveListItem[]> {
  return (await request("/problems")).json();
}

export async function getSolveProblem(slug: string): Promise<SolveProblem> {
  return (await request(`/problems/${encodeURIComponent(slug)}`)).json();
}

// --- Submissions ------------------------------------------------------------
// Types mirror the Pydantic models in backend/routers/submissions.py.

export type SubmissionStatus =
  | "queued"
  | "compiling"
  | "running"
  | "done"
  | "delayed"
  | "review";

/** True once judging has ended and the result will not change by itself. */
export function isFinalStatus(status: SubmissionStatus): boolean {
  return status === "done" || status === "review";
}

export type SubmissionListItem = {
  id: number;
  language: Language;
  status: SubmissionStatus;
  /** A judge verdict code (AC, WA, ...); a newer judge may send unknown ones. */
  verdict: string | null;
  score_milli: number | null;
  max_points: number;
  is_staff: boolean;
  created_at: string;
};

export type TestResult = {
  ordinal: number;
  visibility: TestCaseVisibility;
  verdict: string;
  time_ms: number | null;
  memory_kb: number | null;
  // The fields below are null when the viewer may not see them
  checker_msg: string | null;
  input: string | null;
  input_truncated: boolean;
  expected: string | null;
  expected_truncated: boolean;
  output: string | null;
  output_truncated: boolean;
  /** Only on a case that did not pass. */
  hint_md: string | null;
};

export type Submission = {
  id: number;
  problem: { id: number; slug: string; title: string; version: number };
  language: Language;
  status: SubmissionStatus;
  verdict: string | null;
  score_milli: number | null;
  max_points: number;
  checker_strict: boolean;
  attempt: number;
  is_staff: boolean;
  /** True when this submission sets its author's current score. */
  is_current: boolean;
  created_at: string;
  finished_at: string | null;
  source_name: string;
  source: string;
  compile_log: string | null;
  tests_total: number;
  results: TestResult[];
  /** True when hidden-case details are included (staff, admin). */
  staff_view: boolean;
  author: { login_id: string; display_name: string } | null;
  judge_reason: string | null;
};

/** One message of the live status stream. It carries no test data. */
export type SubmissionProgress = {
  id: number;
  status: SubmissionStatus;
  tests_done: number;
  verdict: string | null;
  score_milli: number | null;
};

export async function submitSolution(
  slug: string,
  language: string,
  source: string,
): Promise<Submission> {
  return (
    await post(`/problems/${encodeURIComponent(slug)}/submissions`, {
      language,
      source,
    })
  ).json();
}

/** The viewer's own submissions to one problem, newest first. */
export async function listMySubmissions(
  slug: string,
): Promise<SubmissionListItem[]> {
  return (
    await request(`/submissions?problem=${encodeURIComponent(slug)}`)
  ).json();
}

/**
 * One result report. Staff get hidden-case details unless `studentView` is
 * set, which gives them exactly what the student would see.
 */
export async function getSubmission(
  id: number,
  options: { studentView?: boolean } = {},
): Promise<Submission> {
  const query = options.studentView ? "?student_view=true" : "";
  return (await request(`/submissions/${id}${query}`)).json();
}

/** Submissions from everyone that the judge has not started yet. */
export async function getQueueCount(): Promise<number> {
  const data: { queued: number } = await (
    await request("/submissions/queue")
  ).json();
  return data.queued;
}

/** URL of the live status stream (Server-Sent Events) of a submission. */
export function submissionStreamUrl(id: number): string {
  return `${API_URL}/submissions/${id}/stream`;
}
