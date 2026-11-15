/**
 * Light / dark theme: the `.dark` class on <html> (tokens in globals.css).
 *
 * The choice is kept in this browser's localStorage. Until the user picks
 * one, the theme follows the system setting. The server cannot know either,
 * so it always renders light and `THEME_INIT_SCRIPT` (inlined in the root
 * layout's <head>) corrects the class before the first paint.
 *
 * No hooks here: the root layout, a Server Component, imports this module.
 * Components read the current theme with `useIsDark()` (lib/use-is-dark.ts).
 */

const STORAGE_KEY = "flabsheet:theme";

/** Must stay in step with `applyStoredTheme` below: it is the same logic, before React loads. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${STORAGE_KEY}");var d=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;

function storedTheme(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private mode or storage disabled: fall back to the system setting
    return null;
  }
}

/** Sets the class from the stored choice, or from the system setting without one. */
export function applyStoredTheme(): void {
  const stored = storedTheme();
  const dark = stored
    ? stored === "dark"
    : window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", dark);
}

/** Switches the theme now and remembers the choice for later visits. */
export function setDarkTheme(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);
  try {
    window.localStorage.setItem(STORAGE_KEY, dark ? "dark" : "light");
  } catch {
    // The switch still holds for this page load
  }
}
