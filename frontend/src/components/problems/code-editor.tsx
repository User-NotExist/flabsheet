"use client";

import { cpp } from "@codemirror/lang-cpp";
import { python } from "@codemirror/lang-python";
import CodeMirror from "@uiw/react-codemirror";
import { useSyncExternalStore } from "react";

/** Syntax highlighting by judge language id; unknown ids get plain text. */
function extensionsFor(languageId: string) {
  if (languageId.startsWith("cpp")) return [cpp()];
  if (languageId.startsWith("py")) return [python()];
  return [];
}

// The theme follows the `.dark` class on <html> (see globals.css)
function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

type Props = {
  value: string;
  onChange: (value: string) => void;
  languageId: string;
  ariaLabel: string;
  readOnly?: boolean;
};

export function CodeEditor({ value, onChange, languageId, ariaLabel, readOnly }: Props) {
  const dark = useSyncExternalStore(
    subscribeToTheme,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensionsFor(languageId)}
      theme={dark ? "dark" : "light"}
      readOnly={readOnly}
      aria-label={ariaLabel}
      height="24rem"
      className="overflow-hidden rounded-lg border text-sm"
    />
  );
}
