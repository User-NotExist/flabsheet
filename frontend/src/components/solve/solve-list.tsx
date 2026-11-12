"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { formatPoints, formatScore, shortLanguage } from "@/components/submissions/format";
import { Badge } from "@/components/ui/badge";
import { listSolveProblems, type SolveListItem, type SolveState } from "@/lib/api";
import { useApiError } from "@/lib/use-api-error";

const STATES: Record<SolveState, { label: string; className: string }> = {
  solved: { label: "Solved", className: "bg-success text-success-foreground" },
  attempted: { label: "Attempted", className: "bg-warning text-warning-foreground" },
  not_attempted: { label: "Not attempted", className: "bg-muted text-muted-foreground" },
};

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

      {problems === null && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading problems…
        </p>
      )}
      {problems?.length === 0 && (
        <p className="rounded-xl border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          No problems are open yet. Check back when your staff enable one.
        </p>
      )}
      {problems && problems.length > 0 && (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Problem</th>
                <th className="px-3 py-2.5 font-medium">Languages</th>
                <th className="px-3 py-2.5 text-right font-medium">Your score</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {problems.map((problem) => {
                const state = STATES[problem.state];
                return (
                  <tr key={problem.slug} className="border-b last:border-b-0">
                    <td className="px-4 py-3">
                      <Link
                        href={`/problems/${problem.slug}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {problem.title}
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-foreground/75">
                      {problem.languages.map((l) => shortLanguage(l.display)).join(", ")}
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">
                      {formatScore(problem.score_milli, problem.max_points)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary" className={state.className}>
                        {state.label}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
