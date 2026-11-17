/**
 * How the leaderboard writes its freeze time, shared by the student page and
 * the staff control so both name the same moment the same way.
 */

/** "14:00 today", "21:40 yesterday", else "14:00 on 17/11/2026", in the viewer's time zone. */
export function formatFrozenAt(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.ceil((startOfToday.getTime() - date.getTime()) / 86_400_000);
  if (days <= 0) return `${time} today`;
  if (days === 1) return `${time} yesterday`;
  return `${time} on ${date.toLocaleDateString()}`;
}
