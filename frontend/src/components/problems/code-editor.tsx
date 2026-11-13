"use client";

import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionKeymap,
  selectedCompletion,
} from "@codemirror/autocomplete";
import { cpp } from "@codemirror/lang-cpp";
import { python } from "@codemirror/lang-python";
import CodeMirror, { type EditorView, type Extension, keymap, Prec } from "@uiw/react-codemirror";

import { cppCompletion } from "@/components/problems/cpp-completion";
import { useIsDark } from "@/lib/use-is-dark";

/**
 * Enter accepts the selected completion, except when the word is already
 * typed in full: accepting would change nothing and swallow the key, so
 * `else` + Enter would not start a new line. Closing the popup and declining
 * the key lets the editor's normal Enter run.
 */
function acceptUnlessTyped(view: EditorView) {
  const selected = selectedCompletion(view.state);
  // A completion with `apply` (a snippet, a header) inserts more than its label.
  if (selected && selected.apply === undefined) {
    const { head } = view.state.selection.main;
    const start = head - selected.label.length;
    const typed =
      view.state.sliceDoc(start, head) === selected.label &&
      !/\w/.test(view.state.sliceDoc(start - 1, start));
    if (typed) {
      closeCompletion(view);
      return false;
    }
  }
  return acceptCompletion(view);
}

// Replaces the autocompletion that basicSetup would add (turned off below),
// only to swap the Enter binding. Prec.highest matches the default keymap, so
// the arrow keys move in the popup instead of in the text.
const completion: Extension = [
  autocompletion({ defaultKeymap: false }),
  Prec.highest(
    keymap.of(
      completionKeymap.map((binding) =>
        binding.key === "Enter" ? { ...binding, run: acceptUnlessTyped } : binding,
      ),
    ),
  ),
];

const BASIC_SETUP = { autocompletion: false, completionKeymap: false };

// Module scope keeps the arrays stable: a new array on every render would make
// the editor reconfigure itself each time.
const CPP = [cpp(), cppCompletion, completion];
const PYTHON = [python(), completion];
const PLAIN = [completion];

/**
 * Highlighting and completion by judge language id; unknown ids get plain
 * text. Python's completion ships with `python()`, C++'s is `cppCompletion`.
 */
function extensionsFor(languageId: string) {
  if (languageId.startsWith("cpp")) return CPP;
  if (languageId.startsWith("py")) return PYTHON;
  return PLAIN;
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
      basicSetup={BASIC_SETUP}
      theme={dark ? "dark" : "light"}
      readOnly={readOnly}
      aria-label={ariaLabel}
      height="24rem"
      className="overflow-hidden rounded-lg border text-sm"
    />
  );
}
