/**
 * The problem editor's form state and its mapping to and from the API.
 *
 * Numbers are kept as the strings the inputs hold and parsed on save, so a
 * half-typed value never turns into NaN or 0 behind the user's back.
 */

import {
  MAX_HINT_LENGTH,
  MAX_SOURCE_BYTES,
  SLUG_PATTERN,
  type Language,
  type ProblemConfig,
  type ProblemDetail,
  type TestCaseVisibility,
} from "@/lib/api";

export type TestRow = {
  /** Stable React key; not sent to the backend. */
  key: string;
  input_sha256: string;
  input_preview: string;
  input_truncated: boolean;
  visibility: TestCaseVisibility;
  hint: string;
};

export type LanguageChoice = { allowed: boolean; time_limit_ms: string };

export type EditorForm = {
  title: string;
  slug: string;
  statement: string;
  max_points: string;
  time_limit_ms: string;
  memory_limit_mb: string;
  checker_strict: boolean;
  float_abs: string;
  float_rel: string;
  languages: Record<string, LanguageChoice>;
  reference_language: string;
  reference_source: string;
  tests: TestRow[];
};

/** The fields that are edited in place; everything else is versioned. */
export type ProblemFields = Pick<EditorForm, "title" | "slug" | "statement">;

const text = (value: number | null) => (value === null ? "" : String(value));

export function formFromDetail(
  detail: ProblemDetail,
  languages: Language[],
): EditorForm {
  const version = detail.version;
  const limits = new Map(
    version?.languages.map((l) => [l.language_id, l.time_limit_ms]),
  );
  return {
    title: detail.title,
    slug: detail.slug,
    statement: detail.statement_md,
    max_points: String(version?.max_points ?? 100),
    time_limit_ms: String(version?.time_limit_ms ?? 1000),
    memory_limit_mb: String(version?.memory_limit_mb ?? 256),
    // Strict is the default for new problems (FR-PRB-17)
    checker_strict: version?.checker_strict ?? true,
    float_abs: text(version?.float_abs ?? null),
    float_rel: text(version?.float_rel ?? null),
    languages: Object.fromEntries(
      languages.map((language) => [
        language.id,
        {
          // A new problem allows every language until staff say otherwise
          allowed: version ? limits.has(language.id) : true,
          time_limit_ms: text(limits.get(language.id) ?? null),
        },
      ]),
    ),
    reference_language: version?.reference_language ?? languages[0]?.id ?? "",
    reference_source: version?.reference_source ?? "",
    tests:
      version?.test_cases.map((testCase) => ({
        key: `saved-${testCase.id}`,
        input_sha256: testCase.input_sha256,
        input_preview: testCase.input_preview,
        input_truncated: testCase.input_truncated,
        visibility: testCase.visibility,
        hint: testCase.hint_md ?? "",
      })) ?? [],
  };
}

/** A build needs a reference solution and at least one test. */
export function hasBuildableConfig(form: EditorForm): boolean {
  return form.reference_source.trim() !== "" && form.tests.length > 0;
}

function wholeNumber(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
}

function tolerance(value: string): number | null | "invalid" {
  if (value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : "invalid";
}

/** The message for the first problem with title or slug, or null. */
export function validateFields(form: EditorForm): string | null {
  if (!form.title.trim()) return "Enter a title.";
  if (!SLUG_PATTERN.test(form.slug)) {
    return "The URL slug may use lower-case letters, digits and hyphens, up to 64 characters.";
  }
  return null;
}

/**
 * The versioned part as the API wants it, or the message for the first
 * invalid value. Call only when `hasBuildableConfig(form)`.
 */
export function configFromForm(
  form: EditorForm,
): { config: ProblemConfig } | { error: string } {
  const maxPoints = wholeNumber(form.max_points, 1, 1_000_000);
  if (maxPoints === null) return { error: "Max points must be a whole number of at least 1." };
  const timeLimit = wholeNumber(form.time_limit_ms, 1, 60_000);
  if (timeLimit === null) return { error: "The time limit must be between 1 and 60000 ms." };
  const memoryLimit = wholeNumber(form.memory_limit_mb, 1, 8192);
  if (memoryLimit === null) return { error: "The memory limit must be between 1 and 8192 MB." };
  const floatAbs = tolerance(form.float_abs);
  const floatRel = tolerance(form.float_rel);
  if (floatAbs === "invalid" || floatRel === "invalid") {
    return { error: "A float tolerance must be a number of 0 or more, such as 1e-6." };
  }

  const languages = [];
  for (const [id, choice] of Object.entries(form.languages)) {
    if (!choice.allowed) continue;
    let override: number | null = null;
    if (choice.time_limit_ms.trim() !== "") {
      override = wholeNumber(choice.time_limit_ms, 1, 60_000);
      if (override === null) {
        return { error: "A language's time limit must be between 1 and 60000 ms, or empty." };
      }
    }
    languages.push({ language_id: id, time_limit_ms: override });
  }
  if (languages.length === 0) return { error: "Allow at least one language." };
  if (!form.languages[form.reference_language]?.allowed) {
    return { error: "The reference solution's language must be one of the allowed languages." };
  }
  if (new TextEncoder().encode(form.reference_source).length > MAX_SOURCE_BYTES) {
    return { error: "The reference solution is larger than 64 KB." };
  }
  if (form.tests.some((test) => test.hint.length > MAX_HINT_LENGTH)) {
    return { error: `A hint can be at most ${MAX_HINT_LENGTH} characters.` };
  }

  return {
    config: {
      max_points: maxPoints,
      time_limit_ms: timeLimit,
      memory_limit_mb: memoryLimit,
      checker_strict: form.checker_strict,
      float_abs: floatAbs,
      float_rel: floatRel,
      languages,
      reference_language: form.reference_language,
      reference_source: form.reference_source,
      test_cases: form.tests.map((test) => ({
        input_sha256: test.input_sha256,
        visibility: test.visibility,
        hint_md: test.hint.trim() ? test.hint : null,
      })),
    },
  };
}
