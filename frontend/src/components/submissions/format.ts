/**
 * How scores, times and sizes of submissions are written, shared by every
 * page that shows them so they always read the same.
 */

/** Milli-points as points with at most 2 decimals: 50000 → "50", 33333 → "33.33". */
export function formatPoints(scoreMilli: number): string {
  return String(Math.round(scoreMilli / 10) / 100);
}

/** "50 / 100", or "– / 100" while there is no score. */
export function formatScore(scoreMilli: number | null, maxPoints: number): string {
  return `${scoreMilli === null ? "–" : formatPoints(scoreMilli)} / ${maxPoints}`;
}

export function formatTime(ms: number | null): string {
  return ms === null ? "–" : `${ms} ms`;
}

export function formatMemory(kb: number | null): string {
  return kb === null ? "–" : `${(kb / 1024).toFixed(1)} MB`;
}

/** A time limit: whole seconds as "1 s", anything else as "1500 ms". */
export function formatLimit(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

/** "C++20 (g++ 13)" → "C++20": the toolchain only matters to staff. */
export function shortLanguage(display: string): string {
  return display.replace(/\s*\(.*\)$/, "");
}

/** "Today 13:20", "Yesterday 21:40", else the date and time, in the viewer's timezone. */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.ceil((startOfToday.getTime() - date.getTime()) / 86_400_000);
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${date.toLocaleDateString()} ${time}`;
}
