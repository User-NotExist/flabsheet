/**
 * Code drafts kept in this browser's localStorage, one per user, problem and
 * language (FR-STD-05), plus the language last used on each problem.
 *
 * Keys carry the user id because lab computers are shared: the next student
 * to sign in must not find the previous one's code in the editor. Every
 * function swallows storage errors (private mode, quota), so a draft is a
 * convenience and never a reason for the page to fail.
 */

const PREFIX = "flabsheet";

function draftKey(userId: number, slug: string, languageId: string): string {
  return `${PREFIX}:draft:${userId}:${slug}:${languageId}`;
}

function languageKey(userId: number, slug: string): string {
  return `${PREFIX}:language:${userId}:${slug}`;
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): boolean {
  try {
    if (value === "") window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function readDraft(userId: number, slug: string, languageId: string): string {
  return read(draftKey(userId, slug, languageId)) ?? "";
}

/** Returns false when the browser refused to store the draft. */
export function writeDraft(
  userId: number,
  slug: string,
  languageId: string,
  source: string,
): boolean {
  return write(draftKey(userId, slug, languageId), source);
}

export function readLanguage(userId: number, slug: string): string | null {
  return read(languageKey(userId, slug));
}

export function writeLanguage(userId: number, slug: string, languageId: string): void {
  write(languageKey(userId, slug), languageId);
}
