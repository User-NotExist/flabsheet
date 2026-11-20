"use client";

import { MessageSquareIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { AuthorName, ThreadBadges } from "@/components/clarifications/badges";
import { ThreadForm, type ThreadValues } from "@/components/clarifications/post-forms";
import { ThreadView } from "@/components/clarifications/thread-view";
import { formatWhen } from "@/components/submissions/format";
import { Button } from "@/components/ui/button";
import {
  createProblemClarification,
  listProblemClarifications,
  type Clarification,
  type ClarificationListItem,
} from "@/lib/api";
import { notifyError, notifySuccess } from "@/lib/notify";
import { useApiError } from "@/lib/use-api-error";

/** The list row of a thread that just changed, without a refetch. */
function toItem(thread: Clarification): ClarificationListItem {
  const { replies, permissions, ...item } = thread;
  void permissions;
  return { ...item, reply_count: replies.length };
}

/** Pinned first, then the most recently active: the order the backend sends. */
function sortThreads(threads: ClarificationListItem[]): ClarificationListItem[] {
  return [...threads].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at),
  );
}

/**
 * The Clarifications tab of a problem: its announcements and questions (the
 * public ones and the caller's own; staff see all), an ask form, and one
 * thread at a time with its replies.
 *
 *   <ClarificationPanel slug={problem.slug} staff={problem.preview} onCount={setCount} />
 */
export function ClarificationPanel({
  slug,
  staff,
  onCount,
}: {
  slug: string;
  /** Staff and admins may also post announcements here. */
  staff: boolean;
  /** How many threads the caller can see, for the tab label. */
  onCount?: (count: number) => void;
}) {
  const toMessage = useApiError();
  const [threads, setThreads] = useState<ClarificationListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  useLayoutEffect(() => () => {
    setError(null);
    setAsking(false);
  }, []);

  // Runs again when the page is shown, so new replies and threads appear
  useEffect(() => {
    let cancelled = false;
    listProblemClarifications(slug)
      .then((items) => {
        if (cancelled) return;
        setThreads(items);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(toMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [slug, revision, toMessage]);

  const count = threads?.length;
  useEffect(() => {
    if (count !== undefined) onCount?.(count);
  }, [count, onCount]);

  function replaceThread(thread: Clarification) {
    setThreads((current) =>
      current && sortThreads(current.map((item) => (item.id === thread.id ? toItem(thread) : item))),
    );
  }

  function dropThread(id: string) {
    setOpen(null);
    setThreads((current) => current?.filter((item) => item.id !== id) ?? null);
  }

  async function ask(values: ThreadValues): Promise<boolean> {
    try {
      const created = await createProblemClarification(slug, {
        kind: staff ? values.kind : "question",
        title: values.title,
        body_md: values.body_md,
        tags: values.tags,
        // Only staff publish a question: they read it before every student can
        visibility: staff ? values.visibility : undefined,
      });
      notifySuccess(
        created.kind === "announcement"
          ? "Announcement posted. Students were notified."
          : "Question sent. Staff will answer here.",
      );
      setAsking(false);
      setOpen(created.id);
      setThreads((current) => sortThreads([toItem(created), ...(current ?? [])]));
      return true;
    } catch (err) {
      notifyError(toMessage(err));
      return false;
    }
  }

  if (open) {
    return (
      <div className="flex flex-col gap-4">
        <Button variant="link" className="w-fit px-0" onClick={() => setOpen(null)}>
          ← All clarifications
        </Button>
        <ThreadView id={open} onChange={replaceThread} onDelete={() => dropThread(open)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground">
          {staff
            ? "Questions from students and your announcements on this problem."
            : "Ask about the statement here. Only you and staff see your questions; staff may make one public for everyone."}
        </p>
        {!asking && (
          <Button size="sm" onClick={() => setAsking(true)}>
            {staff ? "New post" : "Ask a question"}
          </Button>
        )}
      </div>

      {asking && (
        <div className="rounded-lg border p-4">
          <ThreadForm
            allowKind={staff}
            allowVisibility={staff}
            initial={staff ? { kind: "announcement", visibility: "public" } : undefined}
            submitLabel="Post"
            pendingLabel="Posting…"
            onCancel={() => setAsking(false)}
            onSubmit={ask}
          />
        </div>
      )}

      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <FormError message={error} />
          <Button variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>
            Retry
          </Button>
        </div>
      )}

      {threads === null ? (
        !error && <p className="text-muted-foreground">Loading clarifications…</p>
      ) : threads.length === 0 ? (
        <p className="text-muted-foreground">No questions or announcements yet.</p>
      ) : (
        <ul className="flex flex-col">
          {threads.map((thread) => (
            <li key={thread.id} className="border-b last:border-b-0">
              <button
                type="button"
                onClick={() => setOpen(thread.id)}
                className="flex w-full flex-col gap-1.5 py-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="font-medium break-words">{thread.title}</span>
                <ThreadBadges thread={thread} />
                <span className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                  <AuthorName author={thread.author} />
                  <span>· {formatWhen(thread.updated_at)}</span>
                  <span className="inline-flex items-center gap-1">
                    · <MessageSquareIcon aria-hidden className="size-3.5" />
                    {thread.reply_count}
                    <span className="sr-only">{thread.reply_count === 1 ? "reply" : "replies"}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
