"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { createDataColumnHelper, DataTable } from "@/components/data-table/data-table";
import { formatFrozenAt } from "@/components/leaderboard/format";
import { useInstanceSettings } from "@/components/settings/instance-settings";
import { formatPoints } from "@/components/submissions/format";
import {
  getLeaderboard,
  setLeaderboardMode,
  type Leaderboard,
  type LeaderboardMode,
  type LeaderboardRow,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useApiError } from "@/lib/use-api-error";

// Staff watch this page during a session, so the standings refresh more often
// than the student page; the backend caches them for 5 s anyway
const REFRESH_MS = 15_000;

const MODES: { mode: LeaderboardMode; label: string; description: string }[] = [
  { mode: "live", label: "Live", description: "Students see current standings." },
  { mode: "hidden", label: "Hidden", description: "The leaderboard page is turned off for students." },
  {
    mode: "frozen",
    label: "Frozen",
    description: "Students see standings as of the moment you freeze. Judging continues.",
  },
];

function summary(mode: LeaderboardMode, frozenAt: string | null): string {
  switch (mode) {
    case "live":
      return "Students see the live leaderboard.";
    case "hidden":
      return "Hidden from students. They still see their own scores on the Problems page.";
    case "frozen":
      return frozenAt
        ? `Frozen at ${formatFrozenAt(frozenAt)}. Switch to Live to reveal current standings.`
        : "Frozen. Switch to Live to reveal current standings.";
  }
}

// Names and ranks can repeat, so rows are keyed by their place in the list
type Row = LeaderboardRow & { position: number };

const helper = createDataColumnHelper<Row>();
// The order is the ranking, so the headers do not sort
const columns = helper.columns([
  helper.accessor("rank", {
    header: "Rank",
    enableSorting: false,
    meta: { cellClassName: "w-16 font-semibold tabular-nums" },
  }),
  helper.accessor((row) => row.login_id ?? "", {
    id: "login_id",
    header: "Student ID",
    enableSorting: false,
    enableGlobalFilter: true,
    meta: { cellClassName: "font-mono text-[13px]" },
  }),
  helper.accessor("display_name", {
    header: "Name",
    enableSorting: false,
    enableGlobalFilter: true,
  }),
  helper.accessor("solved", {
    header: "Solved",
    enableSorting: false,
    meta: { align: "right" },
  }),
  helper.accessor("total_milli", {
    header: "Total score",
    enableSorting: false,
    meta: { align: "right", cellClassName: "font-semibold" },
    cell: ({ getValue }) => formatPoints(getValue()),
  }),
]);

/** Staff leaderboard at /manage/leaderboard: live standings and the Live / Hidden / Frozen switch (FR-MON-07). */
export function LeaderboardControl() {
  const toMessage = useApiError();
  const { refresh: refreshSettings } = useInstanceSettings();
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<LeaderboardMode | null>(null);

  // The router keeps this page mounted (hidden) after navigating away
  useLayoutEffect(() => {
    return () => {
      setError(null);
      setSaving(null);
    };
  }, []);

  const load = useCallback(
    (isCancelled: () => boolean = () => false) => {
      getLeaderboard()
        .then((data) => {
          if (!isCancelled()) setBoard(data);
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

  const choose = async (mode: LeaderboardMode) => {
    if (!board || mode === board.mode || saving) return;
    setSaving(mode);
    setError(null);
    try {
      const result = await setLeaderboardMode(mode);
      setBoard((current) =>
        current && { ...current, mode: result.leaderboard_mode, frozen_at: result.leaderboard_frozen_at },
      );
      // The top bar and other pages read the mode from the settings provider
      refreshSettings();
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const rows = useMemo<Row[] | null>(
    () => board?.rows.map((row, position) => ({ ...row, position })) ?? null,
    [board],
  );
  const current = saving ?? board?.mode;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Leaderboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          You always see live standings here. Choose what students see.
        </p>
      </div>

      <section className="flex flex-col gap-3.5 rounded-xl border bg-card p-5">
        <h2 id="leaderboard-mode" className="font-semibold">What students see</h2>
        <div
          role="radiogroup"
          aria-labelledby="leaderboard-mode"
          className="grid gap-3 sm:grid-cols-3"
        >
          {MODES.map(({ mode, label, description }) => (
            <label
              key={mode}
              className={cn(
                "flex min-h-22 cursor-pointer flex-col gap-1 rounded-lg border-2 px-3.5 py-3 transition-colors",
                "has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                current === mode ? "border-primary bg-primary/10" : "border-input bg-card hover:bg-muted/50",
                (!board || saving !== null) && "cursor-default opacity-70",
              )}
            >
              <input
                type="radio"
                name="leaderboard-mode"
                value={mode}
                checked={current === mode}
                disabled={!board || saving !== null}
                onChange={() => choose(mode)}
                className="sr-only"
              />
              <span className="font-semibold">
                {label}
                {saving === mode && <span className="font-normal text-muted-foreground"> · Saving…</span>}
              </span>
              <span className="text-sm text-muted-foreground">{description}</span>
            </label>
          ))}
        </div>
        {board && (
          <p role="status" className="rounded-lg bg-info px-3.5 py-2.5 text-sm font-medium text-info-foreground">
            {summary(board.mode, board.frozen_at)}
          </p>
        )}
        <FormError message={error} />
      </section>

      <div className="flex flex-col gap-2">
        <h2 className="font-semibold">Live standings</h2>
        <DataTable
          label="Live standings"
          className="min-w-[36rem]"
          data={rows}
          columns={columns}
          getRowId={(row) => String(row.position)}
          search={{ label: "Search by student ID or name" }}
          loadingText={error ? "Could not load the standings." : "Loading the standings…"}
          emptyText="No active students yet."
          noMatchText="No students match your search."
        />
        <p className="text-xs text-muted-foreground">
          Only active students are ranked. Staff test submissions never count.
        </p>
      </div>
    </main>
  );
}
