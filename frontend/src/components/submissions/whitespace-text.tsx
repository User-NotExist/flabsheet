import { cn } from "cn";

/** One line with its spaces and tabs drawn as · and →. */
function markLine(line: string): string {
  return line.replace(/ /g, "·").replace(/\t/g, "→");
}

type Props = {
  text: string;
  /** Draw spaces, tabs and line ends as · → ↵ (FR-STD-08). */
  showWhitespace: boolean;
  /** The text is only the beginning of the real one. */
  truncated?: boolean;
  /** Tint the box, for an output that did not pass. */
  highlight?: boolean;
  className?: string;
};

/**
 * Test input or output in a monospace box. With `showWhitespace` a wrong
 * space or a missing line break becomes visible, which is what a presentation
 * error is about.
 */
export function WhitespaceText({ text, showWhitespace, truncated, highlight, className }: Props) {
  // A final "\n" ends the last line; it does not start an empty one
  const lines = text.split("\n");
  const endsWithNewline = lines.length > 1 && lines[lines.length - 1] === "";
  if (endsWithNewline) lines.pop();

  return (
    <pre
      className={cn(
        "max-h-64 overflow-auto rounded-lg px-3 py-2 font-mono text-[0.8rem] leading-relaxed",
        highlight ? "bg-warning text-warning-foreground" : "bg-muted",
        className,
      )}
    >
      {text === "" ? (
        <span className="text-muted-foreground italic">(empty)</span>
      ) : (
        lines.map((line, index) => {
          const ended = index < lines.length - 1 || endsWithNewline;
          return (
            <span key={index}>
              {showWhitespace ? markLine(line.replace(/\r$/, "")) : line}
              {showWhitespace && ended && (
                // Not part of the text: skipped when the box is copied
                <span aria-hidden="true" className="opacity-60 select-none">
                  ↵
                </span>
              )}
              {ended && "\n"}
            </span>
          );
        })
      )}
      {truncated && (
        <span className="text-muted-foreground italic">{"\n"}… (cut here: the rest is longer)</span>
      )}
    </pre>
  );
}

/** The "Show whitespace" switch that goes with the boxes above. */
export function WhitespaceToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-primary"
      />
      Show whitespace (· space, → tab, ↵ line end)
    </label>
  );
}
