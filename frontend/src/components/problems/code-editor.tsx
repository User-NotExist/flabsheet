"use client";

import { cpp } from "@codemirror/lang-cpp";
import { python } from "@codemirror/lang-python";
import CodeMirror from "@uiw/react-codemirror";

import { useIsDark } from "@/lib/use-is-dark";

/** Syntax highlighting by judge language id; unknown ids get plain text. */
function extensionsFor(languageId: string) {
  if (languageId.startsWith("cpp")) return [cpp()];
  if (languageId.startsWith("py")) return [python()];
  return [];
}

type Props = {
  value: string;
  onChange: (value: string) => void;
  languageId: string;
  ariaLabel: string;
  readOnly?: boolean;
};

export function CodeEditor({ value, onChange, languageId, ariaLabel, readOnly }: Props) {
  const dark = useIsDark();

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
