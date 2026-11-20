"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

import { FormError } from "@/components/auth/form-error";
import { AnnouncementDialog } from "@/components/clarifications/announcement-dialog";
import { AuthorName, ThreadBadges } from "@/components/clarifications/badges";
import { ThreadView } from "@/components/clarifications/thread-view";
import { createDataColumnHelper, DataTable } from "@/components/data-table/data-table";
import { formatWhen } from "@/components/submissions/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listClarifications,
  listProblems,
  type ClarificationKind,
  type ClarificationListItem,
  type ClarificationPage,
  type ClarificationStatus,
  type ProblemListItem,
} from "@/lib/api";
import { useApiError } from "@/lib/use-api-error";

const ALL = "*";

type Query = {
  status: ClarificationStatus | "";
  kind: ClarificationKind | "";
  problem: string;
  pageIndex: number;
  pageSize: number;
};

// The queue opens on what needs an answer
const FIRST_QUERY: Query = { status: "open", kind: "", problem: "", pageIndex: 0, pageSize: 25 };

const STATUS_ITEMS = [
  { value: ALL, label: "Any status" },
  { value: "open", label: "Open" },
  { value: "answered", label: "Answered" },
  { value: "closed", label: "Closed" },
];

const KIND_ITEMS = [
  { value: ALL, label: "Questions and announcements" },
  { value: "question", label: "Questions" },
  { value: "announcement", label: "Announcements" },
];

function FilterSelect({
  id,
  label,
  items,
  value,
  onChange,
}: {
  id: string;
  label: string;
  items: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        items={items}
        value={value || ALL}
        onValueChange={(next) => {
          if (next) onChange(next === ALL ? "" : next);
        }}
      >
        <SelectTrigger id={id} className="min-w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const helper = createDataColumnHelper<ClarificationListItem>();

function queueColumns(open: (id: string) => void) {
  return helper.columns([
    helper.display({
      id: "title",
      header: "Thread",
      cell: ({ row: { original: thread } }) => (
        <div className="flex min-w-56 flex-col gap-1.5">
          <button
            type="button"
            onClick={() => open(thread.id)}
            className="w-fit text-left font-medium break-words text-primary underline-offset-4 hover:underline"
          >
            {thread.title}
          </button>
          <ThreadBadges thread={thread} />
        </div>
      ),
    }),
    helper.display({
      id: "problem",
      header: "Problem",
      cell: ({ row: { original: thread } }) =>
        thread.problem ? (
          thread.problem.title
        ) : (
          <span className="text-muted-foreground">
            {thread.kind === "announcement" ? "Course-wide" : "Deleted problem"}
          </span>
        ),
    }),
    helper.display({
      id: "author",
      header: "Author",
      cell: ({ row: { original: thread } }) => <AuthorName author={thread.author} />,
    }),
    helper.accessor("reply_count", {
      header: "Replies",
      meta: { cellClassName: "tabular-nums" },
    }),
    helper.accessor("updated_at", {
      header: "Last activity",
      cell: ({ getValue }) => formatWhen(getValue()),
      meta: { cellClassName: "whitespace-nowrap" },
    }),
  ]);
}

/**
 * Staff page /manage/clarifications: every thread on every problem, most
 * recently active first, filtered in the request (open questions by default).
 * A row opens the thread in a dialog with the reply and moderation controls.
 */
export function ClarificationQueue({ actions }: { actions?: ReactNode }) {
  const toMessage = useApiError();
  const id = useId();
  const [query, setQuery] = useState<Query>(FIRST_QUERY);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; page: ClarificationPage } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<ProblemListItem[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [announcing, setAnnouncing] = useState(false);

  const requestKey = JSON.stringify([query, revision]);

  useLayoutEffect(() => () => {
    setError(null);
    setOpenId(null);
    setAnnouncing(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    listProblems()
      .then((items) => {
        if (!cancelled) setProblems(items);
      })
      .catch((err) => {
        // The filter just lists no problems; the queue below reports failures
        if (!cancelled) toMessage(err);
      });
    return () => {
      cancelled = true;
    };
  }, [toMessage]);

  useEffect(() => {
    let cancelled = false;
    listClarifications({
      page: query.pageIndex + 1,
      pageSize: query.pageSize,
      status: query.status || undefined,
      kind: query.kind || undefined,
      problem: query.problem || undefined,
    })
      .then((page) => {
        if (cancelled) return;
        setError(null);
        const lastPage = Math.max(0, Math.ceil(page.total / query.pageSize) - 1);
        if (query.pageIndex > lastPage) {
          // Answering or deleting can empty the last page
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

  const columns = useMemo(() => queueColumns(setOpenId), []);

  const problemItems = useMemo(
    () => [
      { value: ALL, label: "Every problem" },
      ...problems.map((problem) => ({ value: problem.slug, label: problem.title })),
    ],
    [problems],
  );
  const enabled = useMemo(() => problems.filter((p) => p.status === "enabled"), [problems]);

  function filter(patch: Partial<Query>) {
    setQuery((current) => ({ ...current, ...patch, pageIndex: 0 }));
  }

  function refresh() {
    setError(null);
    setRevision((value) => value + 1);
  }

  const pending = loaded !== null && loaded.key !== requestKey && !error;
  const total = loaded?.page.total ?? 0;
  const filtered =
    query.status !== FIRST_QUERY.status || query.kind !== "" || query.problem !== "";

  return (
    <main className="text-sm">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-7 sm:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Clarifications</h1>
            <p className="mt-1 text-muted-foreground">
              Questions from students and announcements, most recently active first. A staff
              reply marks a question answered and notifies its author.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {actions}
            <Button onClick={() => setAnnouncing(true)}>Post announcement</Button>
          </div>
        </header>

        <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border bg-card p-4">
          <FilterSelect
            id={`${id}-status`}
            label="Status"
            items={STATUS_ITEMS}
            value={query.status}
            onChange={(value) => filter({ status: value as Query["status"] })}
          />
          <FilterSelect
            id={`${id}-kind`}
            label="Kind"
            items={KIND_ITEMS}
            value={query.kind}
            onChange={(value) => filter({ kind: value as Query["kind"] })}
          />
          <FilterSelect
            id={`${id}-problem`}
            label="Problem"
            items={problemItems}
            value={query.problem}
            onChange={(value) => filter({ problem: value })}
          />
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              disabled={!filtered}
              onClick={() => filter({ status: FIRST_QUERY.status, kind: "", problem: "" })}
            >
              Reset filters
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
              <Button variant="outline" onClick={refresh}>
                Retry
              </Button>
            </div>
          )}
          <p role="status" className="mb-3 text-muted-foreground">
            {loaded && `${total} ${total === 1 ? "thread" : "threads"}`}
          </p>
          <div className={pending ? "opacity-60 transition-opacity" : "transition-opacity"}>
            <DataTable
              label="Clarifications"
              data={loaded?.page.items ?? null}
              columns={columns}
              getRowId={(thread) => thread.id}
              serverPages={{
                total,
                pageIndex: query.pageIndex,
                pageSize: query.pageSize,
                onChange: (next) => setQuery((current) => ({ ...current, ...next })),
              }}
              loadingText={error ? "Could not load the threads." : "Loading threads…"}
              emptyText={filtered ? "No threads match these filters." : "No open questions."}
              className="min-w-[44rem]"
            />
          </div>
        </section>
      </div>

      <Dialog
        open={openId !== null}
        onOpenChange={(open) => {
          if (open) return;
          setOpenId(null);
          // Status, replies and pins may have changed while it was open
          refresh();
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Thread</DialogTitle>
            <DialogDescription>Reply, moderate or delete.</DialogDescription>
          </DialogHeader>
          {openId && (
            <ThreadView
              id={openId}
              showProblem
              onDelete={() => {
                setOpenId(null);
                refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <AnnouncementDialog
        open={announcing}
        onOpenChange={setAnnouncing}
        problems={enabled}
        onPosted={refresh}
      />
    </main>
  );
}
