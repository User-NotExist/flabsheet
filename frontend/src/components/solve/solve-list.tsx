"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { createDataColumnHelper, DataTable } from "@/components/data-table/data-table";
import { formatPoints, formatScore, shortLanguage } from "@/components/submissions/format";
import { Badge } from "@/components/ui/badge";
import { listSolveProblems, type SolveListItem, type SolveState } from "@/lib/api";
import { useApiError } from "@/lib/use-api-error";

const STATES: Record<SolveState, { label: string; className: string }> = {
  solved: { label: "Solved", className: "bg-success text-success-foreground" },
  attempted: { label: "Attempted", className: "bg-warning text-warning-foreground" },
  not_attempted: { label: "Not attempted", className: "bg-muted text-muted-foreground" },
};

// Sorting by status follows progress, not the alphabet
const STATE_ORDER: Record<SolveState, number> = { not_attempted: 0, attempted: 1, solved: 2 };

const helper = createDataColumnHelper<SolveListItem>();
const columns = helper.columns([
  helper.accessor("title", {
    header: "Problem",
    sortFn: "text",
    enableGlobalFilter: true,
    cell: ({ row, getValue }) => (
      <Link
        href={`/problems/${row.original.slug}`}
        className="font-medium underline-offset-4 hover:underline"
      >
        {getValue()}
      </Link>
    ),
  }),
  helper.accessor(
    (problem) => problem.languages.map((l) => shortLanguage(l.display)).join(", "),
    {
      id: "languages",
      header: "Languages",
      enableSorting: false,
      enableGlobalFilter: true,
      meta: { cellClassName: "text-foreground/75" },
    },
  ),
  // No score yet sorts last either way
  helper.accessor((problem) => problem.score_milli ?? undefined, {
    id: "score",
    header: "Your score",
    sortFn: "basic",
    sortUndefined: "last",
    sortDescFirst: true,
    meta: { align: "right", cellClassName: "whitespace-nowrap" },
    cell: ({ row }) => formatScore(row.original.score_milli, row.original.max_points),
  }),
  helper.accessor((problem) => STATES[problem.state].label, {
    id: "state",
    header: "Status",
    sortFn: (a, b) => STATE_ORDER[a.original.state] - STATE_ORDER[b.original.state],
    enableGlobalFilter: true,
    cell: ({ row, getValue }) => (
      <Badge variant="secondary" className={STATES[row.original.state].className}>
        {getValue()}
      </Badge>
    ),
  }),
]);

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** The student problem list at /problems: open problems with the viewer's own score (FR-STD-01). */
export function SolveList() {
  const toMessage = useApiError();
  const [problems, setProblems] = useState<SolveListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The router keeps this page mounted (hidden) after navigating away
  useLayoutEffect(() => {
    return () => setError(null);
  }, []);

  // Runs again each time the page is shown, so scores are fresh after a submit
  useEffect(() => {
    let cancelled = false;
    listSolveProblems()
      .then((items) => {
        if (!cancelled) setProblems(items);
      })
      .catch((err) => {
        if (!cancelled) setError(toMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [toMessage]);

  const solved = problems?.filter((p) => p.state === "solved").length ?? 0;
  const total = problems?.reduce((sum, p) => sum + (p.score_milli ?? 0), 0) ?? 0;
  const max = problems?.reduce((sum, p) => sum + p.max_points, 0) ?? 0;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Problems</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your score on each problem is the result of your latest submission.
          </p>
        </div>
        {problems && problems.length > 0 && (
          <div className="flex gap-3">
            <Tile label="Solved" value={`${solved} of ${problems.length}`} />
            <Tile label="Total score" value={`${formatPoints(total)} / ${max}`} />
          </div>
        )}
      </div>

      <FormError message={error} />

      <DataTable
        label="Problems"
        className="min-w-[34rem]"
        data={problems}
        columns={columns}
        getRowId={(problem) => problem.slug}
        search={{ label: "Search by title, language or status" }}
        loadingText={error ? "Could not load problems." : "Loading problems…"}
        emptyText="No problems are open yet. Check back when your staff enable one."
        noMatchText="No problems match your search."
      />
    </main>
  );
}
