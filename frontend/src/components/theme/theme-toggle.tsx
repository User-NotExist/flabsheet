"use client";

import { MoonIcon, SunIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { setDarkTheme } from "@/lib/theme";
import { useIsDark } from "@/lib/use-is-dark";

/** Icon button in the top bar that switches between the light and dark theme. */
export function ThemeToggle() {
  const dark = useIsDark();
  const label = dark ? "Switch to light mode" : "Switch to dark mode";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      className="text-foreground/75"
      onClick={() => setDarkTheme(!dark)}
    >
      {/* Picked by CSS, not by `dark`: the right icon shows before hydration */}
      <SunIcon aria-hidden className="hidden dark:block" />
      <MoonIcon aria-hidden className="dark:hidden" />
    </Button>
  );
}
