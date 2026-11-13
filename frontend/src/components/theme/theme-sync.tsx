"use client";

import { useLayoutEffect } from "react";

import { applyStoredTheme } from "@/lib/theme";

/**
 * Re-applies the theme class after React mounts. In development, Strict
 * Mode's remount resets <html> to the attributes in the JSX, which drops the
 * `.dark` class the inline script set. In production this changes nothing.
 */
export function ThemeSync() {
  useLayoutEffect(applyStoredTheme, []);
  return null;
}
