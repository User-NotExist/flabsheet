import { MarkdownView } from "@/components/problems/markdown-view";
import {
  formatMemory,
  formatTime,
} from "@/components/submissions/format";
import {
  VerdictBadge,
  verdictInfo,
} from "@/components/submissions/verdict-badge";
import { WhitespaceText } from "@/components/submissions/whitespace-text";
import type { Submission, TestResult } from "@/lib/api";

type ReportProps = {
  submission: Submission;
  showWhitespace: boolean;
  /**
   * "table": one row per test, then the details of the tests that failed
   * (problem page). "cards": every test with its details (submission page).
   */
  layout: "table" | "cards";
};

/**
 * Whether the test's data may be drawn. A hidden test's data is shown to
 * staff only; the check is repeated here so it stays hidden even if a student
 * response carried it by mistake (NFR-SEC-07).
 */
function showsData(result: TestResult, staffView: boolean): boolean {
  return result.visibility !== "hidden" || staffView;
}

function TestData({
  result,
  staffView,
  showWhitespace,
}: {
  result: TestResult;
  staffView: boolean;
  showWhitespace: boolean;
}) {
  if (!showsData(result, staffView)) return null;
  const failed = result.verdict !== "AC";
  const columns: { label: string; text: string | null; truncated: boolean; highlight?: boolean }[] = [
    { label: "Input", text: result.input, truncated: result.input_truncated },
    { label: "Expected", text: result.expected, truncated: result.expected_truncated },
    {
      label: staffView ? "Output" : "Your output",
      text: result.output,
      truncated: result.output_truncated,
      highlight: failed,
    },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {columns.map(({ label, text, truncated, highlight }) => (
        <div key={label} className="flex min-w-0 flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">{label}</span>
          {text === null ? (
            <p className="rounded-lg bg-muted px-3 py-2 text-[0.8rem] text-muted-foreground italic">
              {result.visibility === "hidden"
                ? "Not kept for hidden tests."
                : "No output was recorded."}
            </p>
          ) : (
            <WhitespaceText
              text={text}
              showWhitespace={showWhitespace}
              truncated={truncated}
              highlight={highlight}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** What went wrong on a test, the checker's message and the staff hint. */
function TestNotes({ result, staffView }: { result: TestResult; staffView: boolean }) {
  const failed = result.verdict !== "AC";
  const message = showsData(result, staffView) && failed ? result.checker_msg : null;
  return (
    <>
      {failed && (
        <p className="text-sm text-foreground/80">
          {verdictInfo(result.verdict).meaning}
          {message && (
            <>
              {" "}
              <span className="font-mono text-[0.8rem] break-words">{message}</span>
            </>
          )}
        </p>
      )}
      {failed && result.hint_md && (
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">Hint from staff</span>
          <MarkdownView source={result.hint_md} />
        </div>
      )}
      {!showsData(result, staffView) && (
        <p className="text-sm text-muted-foreground">
          Hidden test: input and output are not shown.
        </p>
      )}
    </>
  );
}

function TestTitle({ result }: { result: TestResult }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <span className="font-semibold">Test {result.ordinal}</span>
      <span className="text-muted-foreground">{result.visibility}</span>
      <VerdictBadge verdict={result.verdict} />
    </span>
  );
}

function TestCard({
  result,
  staffView,
  showWhitespace,
}: {
  result: TestResult;
  staffView: boolean;
  showWhitespace: boolean;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <TestTitle result={result} />
        <span className="text-muted-foreground tabular-nums">
          {formatTime(result.time_ms)} · {formatMemory(result.memory_kb)}
        </span>
      </div>
      <TestData result={result} staffView={staffView} showWhitespace={showWhitespace} />
      <TestNotes result={result} staffView={staffView} />
    </li>
  );
}

function CompileLog({ log }: { log: string | null }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Compiler log</h3>
      <pre className="max-h-96 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-[0.8rem] leading-relaxed whitespace-pre-wrap">
        {log || "(empty: the compiler printed no messages)"}
      </pre>
    </div>
  );
}

/**
 * The per-test results of a judged submission (FR-STD-08, FR-MON-02): verdict,
 * time and memory for every test; input, expected and actual output for
 * sample and visible ones; the hint on a failed one; the compiler log instead
 * when the code did not compile.
 */
export function ResultReport({ submission, showWhitespace, layout }: ReportProps) {
  const { results, staff_view: staffView } = submission;

  if (submission.verdict === "CE") return <CompileLog log={submission.compile_log} />;
  if (results.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {verdictInfo(submission.verdict ?? "").meaning} No test was run.
      </p>
    );
  }

  if (layout === "cards") {
    return (
      <ul className="flex flex-col gap-3">
        {results.map((result) => (
          <TestCard
            key={result.ordinal}
            result={result}
            staffView={staffView}
            showWhitespace={showWhitespace}
          />
        ))}
      </ul>
    );
  }

  // Only tests with something to read below the table: a failure the student
  // can see into, or a hint
  const detailed = results.filter(
    (result) =>
      result.verdict !== "AC" && (showsData(result, staffView) || result.hint_md),
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Test</th>
              <th className="px-3 py-2 font-medium">Verdict</th>
              <th className="px-3 py-2 text-right font-medium">Time</th>
              <th className="py-2 pl-3 text-right font-medium">Memory</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => (
              <tr key={result.ordinal} className="border-b last:border-b-0">
                <td className="py-2.5 pr-3 whitespace-nowrap">
                  Test {result.ordinal}
                  <span className="text-muted-foreground"> · {result.visibility}</span>
                </td>
                <td className="px-3 py-2.5">
                  <VerdictBadge verdict={result.verdict} />
                </td>
                <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">
                  {formatTime(result.time_ms)}
                </td>
                <td className="py-2.5 pl-3 text-right whitespace-nowrap tabular-nums">
                  {formatMemory(result.memory_kb)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detailed.length > 0 && (
        <ul className="flex flex-col gap-3">
          {detailed.map((result) => (
            <li key={result.ordinal} className="flex flex-col gap-3 rounded-xl border p-4">
              <div className="text-sm">
                <TestTitle result={result} />
              </div>
              <TestData result={result} staffView={staffView} showWhitespace={showWhitespace} />
              <TestNotes result={result} staffView={staffView} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One sentence for a result that is not a normal verdict, or null. */
export function resultNotice(submission: Submission): string | null {
  if (submission.status === "review" || submission.verdict === "JE") {
    return "Under review by staff. This result does not change your score.";
  }
  if (submission.verdict === "SE") {
    return "The judge had a problem with this submission. Staff will retry it; it does not change your score.";
  }
  return null;
}
