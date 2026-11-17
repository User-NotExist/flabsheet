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
import CodeMirror, { EditorView, type Extension, keymap, Prec } from "@uiw/react-codemirror";
import { useMemo } from "react";

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
  /**
   * Grow with the code between these heights instead of the fixed 24rem; past
   * `maxHeight` the editor scrolls inside. Without either it stays fixed.
   */
  minHeight?: string;
  maxHeight?: string;
};

export function CodeEditor({
  value,
  onChange,
  languageId,
  ariaLabel,
  readOnly,
  minHeight,
  maxHeight,
}: Props) {
  const dark = useIsDark();
  const grows = minHeight !== undefined || maxHeight !== undefined;
  // With only a min-height on the editor, the content's own `min-height: 100%`
  // has nothing to resolve against, so it shrinks to the typed lines and a
  // click in the empty space below them misses the text. Giving the content
  // and gutter the same minimum keeps the whole box clickable and the line
  // number strip full height. Memoized for the same reason as the arrays above.
  const extensions = useMemo(() => {
    const base = extensionsFor(languageId);
    if (minHeight === undefined) return base;
    return [
      ...base,
      EditorView.theme({ ".cm-content, .cm-gutter": { minHeight } }),
    ];
  }, [languageId, minHeight]);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      basicSetup={BASIC_SETUP}
      theme={dark ? "dark" : "light"}
      readOnly={readOnly}
      aria-label={ariaLabel}
      height={grows ? undefined : "24rem"}
      minHeight={minHeight}
      maxHeight={maxHeight}
      className="overflow-hidden rounded-lg border text-sm"
    />
  );
}
