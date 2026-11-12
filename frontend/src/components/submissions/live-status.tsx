import { cn } from "cn";

import type { SubmissionStatus } from "@/lib/api";

type Props = {
  status: SubmissionStatus;
  testsDone: number;
  testsTotal: number;
};

const ORDER: Record<SubmissionStatus, number> = {
  queued: 0,
  delayed: 0,
  compiling: 1,
  running: 2,
  done: 3,
  review: 3,
};

/**
 * Where a submission is in the judge: queued → compiling → running test n of
 * m → done (FR-STD-07). Past steps get a check mark, the current one is bold.
 */
export function LiveStatus({ status, testsDone, testsTotal }: Props) {
  const at = ORDER[status];
  const running =
    at > 2
      ? `Running tests ${testsDone} of ${testsTotal}`
      : at === 2
        ? `Running test ${Math.min(testsDone + 1, testsTotal)} of ${testsTotal}`
        : "Running tests";
  const steps = ["Queued", "Compiling", running, "Done"];

  return (
    <div className="flex flex-col gap-1.5">
      <ol
        role="status"
        aria-label="Judging progress"
        className="flex flex-wrap gap-x-5 gap-y-1 text-sm"
      >
        {steps.map((label, index) => (
          <li
            key={index}
            aria-current={index === at ? "step" : undefined}
            className={cn(
              index === at
                ? "font-semibold text-foreground"
                : "text-muted-foreground",
              index > at && "opacity-60",
            )}
          >
            {label}
            {index < at ? " ✓" : index === at && at < 3 ? "…" : ""}
          </li>
        ))}
      </ol>
      {status === "delayed" && (
        <p className="text-sm text-muted-foreground">
          Judging is taking longer than usual. Your submission is still in the
          queue; you do not need to submit again.
        </p>
      )}
    </div>
  );
}
