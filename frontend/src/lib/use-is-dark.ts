"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the dark theme is on, re-rendering when it changes:
 *
 *     const dark = useIsDark();
 *
 * Reads the `.dark` class on <html> instead of React state, so every user of
 * the hook follows the toggle (and the pre-paint script in lib/theme.ts)
 * without a provider. The server render and hydration see `false`; prefer
 * the `dark:` Tailwind variant where CSS alone can do the job.
 */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, isDark, () => false);
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}
