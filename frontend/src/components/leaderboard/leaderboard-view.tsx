"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { createDataColumnHelper, DataTable } from "@/components/data-table/data-table";
import { formatFrozenAt } from "@/components/leaderboard/format";
import { useInstanceSettings } from "@/components/settings/instance-settings";
import { formatPoints } from "@/components/submissions/format";
import { ApiError, getLeaderboard, type Leaderboard, type LeaderboardRow } from "@/lib/api";
import { useApiError } from "@/lib/use-api-error";

// Standings move with every judged submission; the backend caches them for 5 s
const REFRESH_MS = 30_000;

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
  helper.accessor("display_name", {
    header: "Name",
    enableSorting: false,
    enableGlobalFilter: true,
    cell: ({ row, getValue }) =>
      row.original.is_me ? <span className="font-semibold">{getValue()} (you)</span> : getValue(),
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

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** The student leaderboard at /leaderboard: live, frozen or hidden, as staff chose (FR-STD-02/03, FR-MON-07). */
export function LeaderboardView() {
  const toMessage = useApiError();
  const { settings } = useInstanceSettings();
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The router keeps this page mounted (hidden) after navigating away
  useLayoutEffect(() => {
    return () => setError(null);
  }, []);

  // Fetch again when staff change the mode (the settings poll notices within
  // 30 s), on a timer, and each time the page is shown
  const mode = settings?.leaderboard_mode;
  const frozenAt = settings?.leaderboard_frozen_at;
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getLeaderboard()
        .then((data) => {
          if (cancelled) return;
          setBoard(data);
          setHidden(false);
          setError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          if (err instanceof ApiError && err.code === "leaderboard_hidden") {
            setHidden(true);
            setBoard(null);
            setError(null);
          } else {
            setError(toMessage(err));
          }
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [toMessage, mode, frozenAt]);

  const rows = useMemo<Row[] | null>(
    () => board?.rows.map((row, position) => ({ ...row, position })) ?? null,
    [board],
  );
  const me = board?.rows.find((row) => row.is_me);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Leaderboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Ranked by total score across open problems. Ties go to whoever reached the total first.
          </p>
        </div>
        {me && (
          <div className="flex gap-3">
            <Tile label="Your rank" value={`${me.rank} of ${board?.rows.length}`} />
            <Tile label="Your total" value={formatPoints(me.total_milli)} />
          </div>
        )}
      </div>

      {board?.showing_snapshot && board.frozen_at && (
        <p role="status" className="rounded-lg bg-info px-3.5 py-2.5 text-sm font-medium text-info-foreground">
          Frozen at {formatFrozenAt(board.frozen_at)}. Standings show scores as of that time; your own
          scores on the <Link href="/problems" className="underline underline-offset-4">Problems</Link> page
          stay live.
        </p>
      )}

      <FormError message={error} />

      {hidden ? (
        <div className="rounded-xl border bg-card px-6 py-14 text-center">
          <h2 className="text-lg font-semibold">The leaderboard is hidden</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Staff have turned it off for now. Your own scores are on the{" "}
            <Link href="/problems" className="text-primary underline-offset-4 hover:underline">
              Problems
            </Link>{" "}
            page.
          </p>
        </div>
      ) : (
        <>
          <DataTable
            label="Leaderboard"
            className="min-w-[28rem]"
            data={rows}
            columns={columns}
            getRowId={(row) => String(row.position)}
            rowClassName={(row) => (row.is_me ? "bg-primary/10 hover:bg-primary/15" : undefined)}
            search={{ label: "Search by name" }}
            loadingText={error ? "Could not load the leaderboard." : "Loading the leaderboard…"}
            emptyText="No students are on the leaderboard yet."
            noMatchText="No students match your search."
          />
          <p className="text-xs text-muted-foreground">
            Student IDs are never shown here. Deactivated students and staff test submissions are left out.
          </p>
        </>
      )}
    </main>
  );
}
