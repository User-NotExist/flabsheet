"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import {
  createDataColumnHelper,
  DataTable,
  type DataTableColumn,
} from "@/components/data-table/data-table";
import { formatExactPoints } from "@/components/submissions/format";
import { buttonVariants } from "@/components/ui/button";
import {
  getProgress,
  SCORES_CSV_URL,
  STUDENT_SUBMISSIONS_CSV_URL,
  type Progress,
  type ProgressCell,
  type ProgressProblem,
  type ProgressRow,
} from "@/lib/api";
import { notifySuccess } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useApiError } from "@/lib/use-api-error";

// Staff keep this open during a lab, so scores refresh without a reload
const REFRESH_MS = 15_000;

// Not attempted sorts below a score of 0
const NO_SCORE = -1;

type Row = ProgressRow & { byProblem: Map<number, ProgressCell> };

const CELL_STYLE: Record<ProgressCell["state"], string> = {
  solved: "bg-success text-success-foreground",
  attempted: "bg-warning text-warning-foreground",
};

const helper = createDataColumnHelper<Row>();

function buildColumns(problems: ProgressProblem[]): DataTableColumn<Row>[] {
  return helper.columns([
    helper.accessor("login_id", {
      header: "Student ID",
      sortFn: "alphanumeric",
      enableGlobalFilter: true,
      meta: { sticky: true, cellClassName: "font-mono text-[13px]" },
    }),
    helper.accessor("display_name", {
      header: "Name",
      sortFn: "text",
      enableGlobalFilter: true,
      meta: { cellClassName: "min-w-32" },
    }),
    ...problems.map((problem) =>
      helper.accessor((row) => row.byProblem.get(problem.id)?.score_milli ?? NO_SCORE, {
        id: `problem-${problem.id}`,
        header: () => <span title={`${problem.slug} · ${problem.max_points} points`}>{problem.title}</span>,
        sortFn: "basic",
        meta: { align: "center" },
        cell: ({ row }) => <ScoreCell cell={row.original.byProblem.get(problem.id)} problem={problem} />,
      }),
    ),
    helper.accessor("total_milli", {
      header: "Total",
      sortFn: "basic",
      meta: { align: "right", cellClassName: "font-semibold" },
      cell: ({ getValue }) => formatExactPoints(getValue()),
    }),
  ]);
}

function ScoreCell({ cell, problem }: { cell: ProgressCell | undefined; problem: ProgressProblem }) {
  if (!cell) {
    return (
      <span className="text-muted-foreground">
        <span aria-hidden="true">–</span>
        <span className="sr-only">Not attempted</span>
      </span>
    );
  }
  const points = formatExactPoints(cell.score_milli);
  return (
    <Link
      href={`/submissions/${cell.submission_id}`}
      aria-label={`${problem.title}: ${points} of ${problem.max_points} points, ${cell.state}. Open the submission.`}
      className={cn(
        "inline-flex min-w-14 justify-center rounded-md px-2.5 py-1.5 font-semibold tabular-nums outline-none hover:opacity-80 focus-visible:ring-3 focus-visible:ring-ring/50",
        CELL_STYLE[cell.state],
      )}
    >
      {points}
    </Link>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className={cn("size-4 rounded border", className)} />
      {label}
    </span>
  );
}

/** Staff progress matrix at /manage/progress: students × enabled problems, plus the CSV exports (FR-MON-01, 04). */
export function ProgressMatrix() {
  const toMessage = useApiError();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The router keeps this page mounted (hidden) after navigating away
  useLayoutEffect(() => {
    return () => setError(null);
  }, []);

  const load = useCallback(
    (isCancelled: () => boolean) => {
      getProgress()
        .then((data) => {
          if (isCancelled()) return;
          setProgress(data);
          setError(null);
        })
        .catch((err) => {
          if (!isCancelled()) setError(toMessage(err));
        });
    },
    [toMessage],
  );

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    load(isCancelled);
    const timer = setInterval(() => load(isCancelled), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [load]);

  const problems = progress?.problems;
  const columns = useMemo(() => buildColumns(problems ?? []), [problems]);
  const rows = useMemo<Row[] | null>(
    () =>
      progress?.rows.map((row) => ({
        ...row,
        byProblem: new Map(row.cells.map((cell) => [cell.problem_id, cell])),
      })) ?? null,
    [progress],
  );

  const exportStarted = () => notifySuccess("Export started. The CSV file will download shortly.");

  return (
    <main className="text-sm">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-7 sm:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Progress</h1>
            <p className="mt-1 text-muted-foreground">
              Current score per student and enabled problem (from each student&apos;s latest judged submission).
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href={STUDENT_SUBMISSIONS_CSV_URL}
              download
              className={buttonVariants({ variant: "outline" })}
              onClick={exportStarted}
            >
              Export submissions CSV
            </a>
            <a href={SCORES_CSV_URL} download className={buttonVariants()} onClick={exportStarted}>
              Export scores CSV
            </a>
          </div>
        </header>

        <div className="flex flex-wrap gap-x-6 gap-y-2 text-muted-foreground">
          <LegendSwatch className="border-success-foreground/40 bg-success" label="Solved (full score)" />
          <LegendSwatch className="border-warning-foreground/40 bg-warning" label="Attempted" />
          <LegendSwatch className="bg-card" label="– Not attempted" />
        </div>

        <FormError message={error} />

        <DataTable
          label="Progress"
          className="w-max min-w-full"
          data={rows}
          columns={columns}
          getRowId={(row) => String(row.id)}
          paginate={false}
          search={{ label: "Search by student ID or name" }}
          count={(n) => `${n} student${n === 1 ? "" : "s"}`}
          loadingText={error ? "Could not load progress." : "Loading progress…"}
          emptyText="No active students yet."
          noMatchText="No students match your search."
        />

        <p className="text-muted-foreground">
          Click a score to open the submission that set it. Submissions still being judged or under review
          (judge error) do not count yet. Totals match the leaderboard. The scores CSV has one row per student, one
          column per enabled problem, and a total; it opens correctly in Excel and Google Sheets.
        </p>
      </div>
    </main>
  );
}
