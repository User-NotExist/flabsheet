"use client";

import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { Section, StatCard } from "@/components/home/stat-card";
import { formatFrozenAt } from "@/components/leaderboard/format";
import { formatPoints, formatScore } from "@/components/submissions/format";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  ApiError,
  getLeaderboard,
  listSolveProblems,
  type Leaderboard,
  type SolveListItem,
} from "@/lib/api";
import { useApiError } from "@/lib/use-api-error";

const CONTINUE_LIMIT = 5;

// "hidden": staff hid the leaderboard, which is not an error to show
type Standing = Leaderboard | "hidden";

function rankCard(standing: Standing | null, error: string | null) {
  if (error) return <StatCard label="Your rank" value="–" detail="Could not load." />;
  if (standing === null) return <StatCard label="Your rank" value="…" />;
  if (standing === "hidden") {
    return <StatCard label="Your rank" value="–" detail="Hidden by staff." />;
  }
  const me = standing.rows.find((row) => row.is_me);
  const frozen =
    standing.showing_snapshot && standing.frozen_at
      ? `Frozen at ${formatFrozenAt(standing.frozen_at)}.`
      : undefined;
  return (
    <StatCard
      label="Your rank"
      href="/leaderboard"
      value={me ? `#${me.rank}` : "–"}
      detail={
        me
          ? [`of ${standing.rows.length}`, frozen].filter(Boolean).join(" · ")
          : (frozen ?? "Not ranked yet.")
      }
    />
  );
}

/** The student overview: own progress, rank and the problems to work on next. */
export function StudentHome() {
  const toMessage = useApiError();
  const [problems, setProblems] = useState<SolveListItem[] | null>(null);
  const [problemsError, setProblemsError] = useState<string | null>(null);
  const [standing, setStanding] = useState<Standing | null>(null);
  const [standingError, setStandingError] = useState<string | null>(null);

  useLayoutEffect(() => {
    return () => {
      setProblemsError(null);
      setStandingError(null);
    };
  }, []);

  // Runs again each time the page is shown, so scores are fresh after a submit
  useEffect(() => {
    let cancelled = false;
    listSolveProblems()
      .then((items) => {
        if (!cancelled) setProblems(items);
      })
      .catch((err) => {
        if (!cancelled) setProblemsError(toMessage(err));
      });
    getLeaderboard()
      .then((board) => {
        if (!cancelled) setStanding(board);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === "leaderboard_hidden") {
          setStanding("hidden");
        } else {
          setStandingError(toMessage(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [toMessage]);

  const solved = problems?.filter((p) => p.state === "solved").length ?? 0;
  const attempted = problems?.filter((p) => p.state === "attempted").length ?? 0;
  const total = problems?.reduce((sum, p) => sum + (p.score_milli ?? 0), 0) ?? 0;
  const max = problems?.reduce((sum, p) => sum + p.max_points, 0) ?? 0;
  // Unfinished work first, then problems not started yet, each in list order
  const next = problems
    ? [
        ...problems.filter((p) => p.state === "attempted"),
        ...problems.filter((p) => p.state === "not_attempted"),
      ].slice(0, CONTINUE_LIMIT)
    : null;

  const loading = problems === null ? "…" : null;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Solved"
          href="/problems"
          value={loading ?? solved}
          detail={problems ? `of ${problems.length} problems` : undefined}
        />
        <StatCard label="Attempted" value={loading ?? attempted} detail="Not full marks yet." />
        <StatCard
          label="Total score"
          value={loading ?? formatPoints(total)}
          detail={problems ? `of ${max} points` : undefined}
        />
        {rankCard(standing, standingError)}
      </div>

      <Section
        title="Continue solving"
        action={
          <Link href="/problems" className={buttonVariants({ variant: "outline", size: "sm" })}>
            All problems
          </Link>
        }
      >
        <FormError message={problemsError} />
        {next === null && !problemsError && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading problems…
          </p>
        )}
        {next !== null && problems?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No problems are open yet. Check back when your staff enable one.
          </p>
        )}
        {next !== null && next.length === 0 && solved > 0 && (
          <p className="text-sm text-muted-foreground">
            You have solved every open problem. Nice work.
          </p>
        )}
        {next !== null && next.length > 0 && (
          <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
            {next.map((problem) => (
              <li key={problem.slug}>
                <Link
                  href={`/problems/${problem.slug}`}
                  className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/60"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{problem.title}</span>
                  <span className="hidden text-muted-foreground tabular-nums sm:inline">
                    {formatScore(problem.score_milli, problem.max_points)}
                  </span>
                  {problem.state === "attempted" ? (
                    <Badge variant="secondary" className="bg-warning text-warning-foreground">
                      Attempted
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="bg-muted text-muted-foreground">
                      Not attempted
                    </Badge>
                  )}
                  <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
