/**
 * Carries the "Signed out." toast across the full page load that logout does
 * (see `AccountMenu`): the menu marks it, and the landing page shows it once.
 *
 *     markSignedOut(); window.location.replace("/");   // before leaving
 *     if (takeSignedOut()) notifySuccess("Signed out."); // after arriving
 *
 * sessionStorage can be unavailable (private mode, blocked storage); the
 * toast is then skipped, which is harmless.
 */

const KEY = "flabsheet:signed-out";

export function markSignedOut(): void {
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {}
}

/** True once after `markSignedOut()`, then false until it is called again. */
export function takeSignedOut(): boolean {
  try {
    const marked = sessionStorage.getItem(KEY) !== null;
    sessionStorage.removeItem(KEY);
    return marked;
  } catch {
    return false;
  }
}
