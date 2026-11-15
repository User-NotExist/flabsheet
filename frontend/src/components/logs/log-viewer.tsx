"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { createDataColumnHelper, DataTable } from "@/components/data-table/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listOperationLogs,
  listOperationLogTypes,
  type OperationLogEntry,
  type OperationLogPage,
} from "@/lib/api";
import { useApiError } from "@/lib/use-api-error";

/** What the table shows: the filters and the page, sent to the server together. */
type Query = {
  type: string;
  user: string;
  /** Local days as "YYYY-MM-DD", or "" for no limit. */
  from: string;
  to: string;
  pageIndex: number;
  pageSize: number;
};

const NO_FILTERS = { type: "", user: "", from: "", to: "" };
const FIRST_QUERY: Query = { ...NO_FILTERS, pageIndex: 0, pageSize: 25 };

// Select value for "no type filter": never a real type, which are dotted names
const ALL_TYPES = "*";
// Wait for a pause in typing before asking the server again
const USER_SEARCH_DELAY_MS = 300;

/**
 * Midnight that starts the local day `day` ("YYYY-MM-DD"), `addDays` later,
 * as an ISO time. The times in the table are local too, so "From 14 Nov"
 * means the 14th as the reader sees it.
 */
function dayStart(day: string, addDays = 0): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + addDays);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** With seconds: entries of one request are often less than a minute apart. */
function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** `info` as key and value pairs when it is a JSON object, else null. */
function infoPairs(info: string): [string, string][] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(info);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return Object.entries(parsed).map(([key, value]) => [
    key,
    typeof value === "string" ? value : JSON.stringify(value),
  ]);
}

function InfoChips({ info }: { info: string | null }) {
  if (!info) return <span className="text-muted-foreground">–</span>;

  const pairs = infoPairs(info);
  if (pairs === null) return <span className="break-words">{info}</span>;

  return (
    <ul className="flex flex-wrap gap-1">
      {pairs.map(([key, value]) => (
        <li key={key} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
          <span className="text-muted-foreground">{key}: </span>
          {value}
        </li>
      ))}
    </ul>
  );
}

function isFailure(type: string): boolean {
  return type.endsWith("_failed") || type.endsWith("_denied");
}

const helper = createDataColumnHelper<OperationLogEntry>();

// The server orders the rows (newest first), so no column sorts
const columns = helper.columns([
  helper.accessor("created_at", {
    header: "Time",
    cell: ({ getValue }) => formatTimestamp(getValue()),
    meta: { cellClassName: "whitespace-nowrap tabular-nums" },
  }),

  helper.display({
    id: "user",
    header: "User",
    cell: ({ row: { original: entry } }) =>
      entry.user ? (
        <>
          <div className="font-medium break-words">{entry.user.display_name}</div>
          <div className="font-mono text-xs break-all text-muted-foreground">
            {entry.user.login_id}
          </div>
        </>
      ) : (
        <span className="text-muted-foreground">System</span>
      ),
  }),

  helper.accessor("type", {
    header: "Type",
    cell: ({ getValue }) => (
      <Badge variant={isFailure(getValue()) ? "destructive" : "outline"} className="font-mono">
        {getValue()}
      </Badge>
    ),
  }),

  helper.display({
    id: "info",
    header: "Info",
    cell: ({ row }) => <InfoChips info={row.original.info} />,
  }),
]);

export function LogViewer() {
  const toMessage = useApiError();
  const id = useId();

  const [query, setQuery] = useState<Query>(FIRST_QUERY);
  // The search box as typed; it reaches `query.user` after a pause
  const [userText, setUserText] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);

  // The last page that arrived, with the request it answers
  const [loaded, setLoaded] = useState<{ key: string; page: OperationLogPage } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requestKey = JSON.stringify([query, revision]);

  // A cached route can return after logout: don't keep the log around.
  useLayoutEffect(() => () => {
    setLoaded(null);
    setError(null);
  }, []);

  useEffect(() => {
    const next = userText.trim();
    const timer = setTimeout(() => {
      setQuery((current) =>
        current.user === next ? current : { ...current, user: next, pageIndex: 0 },
      );
    }, USER_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [userText]);

  useEffect(() => {
    let cancelled = false;

    listOperationLogTypes()
      .then((items) => {
        if (!cancelled) setTypes(items);
      })
      .catch((err) => {
        // The filter just stays empty; the list below reports the failure
        if (!cancelled) toMessage(err);
      });

    return () => {
      cancelled = true;
    };
  }, [revision, toMessage]);

  useEffect(() => {
    let cancelled = false;

    listOperationLogs({
      page: query.pageIndex + 1,
      pageSize: query.pageSize,
      type: query.type || undefined,
      user: query.user || undefined,
      from: dayStart(query.from),
      // The whole "to" day counts: up to the start of the day after
      to: dayStart(query.to, 1),
    })
      .then((page) => {
        if (cancelled) return;
        setError(null);
        const lastPage = Math.max(0, Math.ceil(page.total / query.pageSize) - 1);
        if (query.pageIndex > lastPage) {
          // The log cannot shrink, but a page typed past the end must not strand the reader
          setQuery((current) => ({ ...current, pageIndex: lastPage }));
          return;
        }
        setLoaded({ key: requestKey, page });
      })
      .catch((err) => {
        if (!cancelled) setError(toMessage(err));
      });

    return () => {
      cancelled = true;
    };
  }, [query, requestKey, toMessage]);

  /** Filters always start again from the newest matching entry. */
  function filter(patch: Partial<typeof NO_FILTERS>) {
    setQuery((current) => ({ ...current, ...patch, pageIndex: 0 }));
  }

  function clearFilters() {
    setUserText("");
    filter(NO_FILTERS);
  }

  function refresh() {
    setError(null);
    setRevision((value) => value + 1);
  }

  const typeItems = useMemo(
    () => [
      { value: ALL_TYPES, label: "All types" },
      ...types.map((type) => ({ value: type, label: type })),
    ],
    [types],
  );

  const filtered =
    userText !== "" || query.type !== "" || query.from !== "" || query.to !== "";
  const pending = loaded !== null && loaded.key !== requestKey && !error;
  const total = loaded?.page.total ?? 0;

  return (
    <main className="min-h-[calc(100vh-3rem)] bg-muted/30 text-sm">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-7 sm:px-6">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Logs</h1>
          <p className="mt-1 text-muted-foreground">
            Only admins see this page. It lists sign-ins, refused requests and changes to
            accounts and problems, newest first.
          </p>
        </header>

        <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border bg-card p-4">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-type`}>Type</Label>
            <Select
              items={typeItems}
              value={query.type || ALL_TYPES}
              onValueChange={(value) => {
                if (value) filter({ type: value === ALL_TYPES ? "" : value });
              }}
            >
              <SelectTrigger id={`${id}-type`} className="min-w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {typeItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid min-w-48 flex-1 gap-1.5">
            <Label htmlFor={`${id}-user`}>User</Label>
            <Input
              id={`${id}-user`}
              type="search"
              autoComplete="off"
              maxLength={100}
              placeholder="Name or login ID"
              value={userText}
              onChange={(event) => setUserText(event.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-from`}>From</Label>
            <Input
              id={`${id}-from`}
              type="date"
              value={query.from}
              max={query.to || undefined}
              onChange={(event) => filter({ from: event.target.value })}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-to`}>To</Label>
            <Input
              id={`${id}-to`}
              type="date"
              value={query.to}
              min={query.from || undefined}
              onChange={(event) => filter({ to: event.target.value })}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" disabled={!filtered} onClick={clearFilters}>
              Clear filters
            </Button>
            <Button variant="outline" onClick={refresh}>
              Refresh
            </Button>
          </div>
        </div>

        <section className="min-w-0" aria-busy={pending}>
          {error && (
            <div className="mb-3 flex items-center gap-2">
              <FormError message={error} />
              <Button variant="outline" onClick={refresh}>Retry</Button>
            </div>
          )}

          <p role="status" className="mb-3 text-muted-foreground">
            {loaded && `${total} ${total === 1 ? "entry" : "entries"}`}
          </p>

          <div className={pending ? "opacity-60 transition-opacity" : "transition-opacity"}>
            <DataTable
              label="Operation log"
              data={loaded?.page.items ?? null}
              columns={columns}
              getRowId={(entry) => String(entry.id)}
              serverPages={{
                total,
                pageIndex: query.pageIndex,
                pageSize: query.pageSize,
                onChange: (next) => setQuery((current) => ({ ...current, ...next })),
              }}
              loadingText={error ? "Could not load the log." : "Loading the log…"}
              emptyText={filtered ? "No entries match these filters." : "The log is empty."}
              className="min-w-[44rem]"
            />
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            Times are in your time zone. Entries cannot be edited or deleted here.
          </p>
        </section>
      </div>
    </main>
  );
}
