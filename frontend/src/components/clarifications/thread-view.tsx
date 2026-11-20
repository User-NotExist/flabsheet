"use client";

import { PinIcon, PinOffIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { AuthorName, STATUS_LABELS, ThreadBadges } from "@/components/clarifications/badges";
import { ReplyForm, ThreadForm } from "@/components/clarifications/post-forms";
import { MarkdownView } from "@/components/problems/markdown-view";
import { formatWhen } from "@/components/submissions/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
  MAX_CLARIFICATION_REPLIES,
  createReply,
  deleteClarification,
  deleteReply,
  getClarification,
  updateClarification,
  updateReply,
  type Clarification,
  type ClarificationStatus,
  type ClarificationUpdate,
} from "@/lib/api";
import { notifyError, notifySuccess } from "@/lib/notify";
import { useApiError } from "@/lib/use-api-error";

const STATUS_ITEMS = (Object.keys(STATUS_LABELS) as ClarificationStatus[]).map((value) => ({
  value,
  label: STATUS_LABELS[value],
}));

const REFRESH_MS = 30_000;

type Editing = { kind: "thread" } | { kind: "reply"; id: string } | null;
type Confirm = { kind: "thread" } | { kind: "reply"; id: string } | null;

/**
 * One thread with its replies and every control the caller may use, as the
 * backend's `permissions` say: edit, delete, reply, and for staff the status,
 * pin and visibility. Used by the problem page and the staff queue.
 *
 *   <ThreadView id={thread.id} onChange={updateRow} onDelete={dropRow} />
 *
 * `onChange` gets the thread after each change, `onDelete` runs once it is gone.
 * `live` re-reads the thread every 30 s while the tab is visible, so replies
 * from others appear without reopening it (the staff queue sets it).
 */
export function ThreadView({
  id,
  showProblem = false,
  live = false,
  onChange,
  onDelete,
}: {
  id: string;
  /** Link to the problem (the staff queue spans every problem). */
  showProblem?: boolean;
  /** Re-read the thread in the background. */
  live?: boolean;
  onChange?: (thread: Clarification) => void;
  onDelete?: () => void;
}) {
  const toMessage = useApiError();
  const [thread, setThread] = useState<Clarification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<Editing>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  // Counts changes made here: a background read that started before one
  // returns an older thread than the change did, so it is dropped
  const changes = useRef(0);

  useLayoutEffect(() => () => {
    setEditing(null);
    setConfirm(null);
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getClarification(id)
      .then((found) => {
        if (cancelled) return;
        setThread(found);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(toMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id, revision, toMessage]);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const poll = () => {
      // A background tab would only add load; it catches up when shown again
      if (document.hidden) return;
      const seen = changes.current;
      getClarification(id)
        .then((found) => {
          if (cancelled || changes.current !== seen) return;
          setThread(found);
          setError(null);
        })
        .catch(() => {
          // A missed poll is retried by the next tick; the thread stays as shown
        });
    };
    const timer = setInterval(poll, REFRESH_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [id, live]);

  /** Run a change, show the thread it returns, and say how it went. */
  async function apply(change: () => Promise<Clarification>, done: string): Promise<boolean> {
    setBusy(true);
    try {
      const next = await change();
      changes.current += 1;
      setThread(next);
      onChange?.(next);
      notifySuccess(done);
      return true;
    } catch (err) {
      notifyError(toMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function moderate(changes: ClarificationUpdate, done: string) {
    void apply(() => updateClarification(id, changes), done);
  }

  async function confirmDelete() {
    const target = confirm;
    if (!target) return;
    setBusy(true);
    try {
      if (target.kind === "thread") {
        await deleteClarification(id);
        notifySuccess("Thread deleted.");
        setConfirm(null);
        onDelete?.();
        return;
      }
      const next = await deleteReply(id, target.id);
      changes.current += 1;
      setThread(next);
      onChange?.(next);
      notifySuccess("Reply deleted.");
      setConfirm(null);
    } catch (err) {
      notifyError(toMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <FormError message={error} />
        <Button variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>
          Retry
        </Button>
      </div>
    );
  }
  // A thread loaded for an earlier id is not shown for this one
  if (!thread || thread.id !== id) {
    return <p className="text-sm text-muted-foreground">Loading the thread…</p>;
  }

  const { permissions } = thread;
  const question = thread.kind === "question";
  const full = thread.replies.length >= MAX_CLARIFICATION_REPLIES;

  return (
    <article className="flex min-w-0 flex-col gap-4 text-sm">
      <header className="flex flex-col gap-2">
        <ThreadBadges thread={thread} />
        {editing?.kind === "thread" ? (
          <ThreadForm
            initial={thread}
            submitLabel="Save"
            pendingLabel="Saving…"
            onCancel={() => setEditing(null)}
            onSubmit={async (values) => {
              const saved = await apply(
                () =>
                  updateClarification(id, {
                    title: values.title,
                    body_md: values.body_md,
                    tags: values.tags,
                  }),
                "Saved.",
              );
              if (saved) setEditing(null);
              return saved;
            }}
          />
        ) : (
          <>
            <h3 className="text-base font-semibold break-words">{thread.title}</h3>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
              <AuthorName author={thread.author} />
              <span>· {formatWhen(thread.created_at)}</span>
              {showProblem && thread.problem && (
                <Link
                  href={`/problems/${thread.problem.slug}#clarifications`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  · {thread.problem.title}
                </Link>
              )}
              {showProblem && !thread.problem && <span>· Course-wide</span>}
            </p>
            <MarkdownView source={thread.body_md} userContent />
          </>
        )}
        {editing === null && (permissions.edit || permissions.delete) && (
          <div className="flex flex-wrap gap-2">
            {permissions.edit && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setEditing({ kind: "thread" })}
              >
                Edit
              </Button>
            )}
            {permissions.delete && (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive"
                disabled={busy}
                onClick={() => setConfirm({ kind: "thread" })}
              >
                Delete thread
              </Button>
            )}
          </div>
        )}
        {!permissions.edit && thread.author.is_me && question && (
          <p className="text-xs text-muted-foreground">
            {thread.visibility === "public"
              ? "Staff made this question public, so it can no longer change. Ask a new question to follow up."
              : "You can edit your question until staff reply, and delete it until anyone replies."}
          </p>
        )}
      </header>

      {permissions.moderate && (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/40 p-3">
          {question && (
            <div className="grid gap-1.5">
              <Label htmlFor={`status-${id}`}>Status</Label>
              <Select
                items={STATUS_ITEMS}
                value={thread.status}
                onValueChange={(value) => {
                  if (value && value !== thread.status) {
                    moderate({ status: value }, `Marked ${STATUS_LABELS[value].toLowerCase()}.`);
                  }
                }}
              >
                <SelectTrigger id={`status-${id}`} className="min-w-32" disabled={busy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              moderate({ pinned: !thread.pinned }, thread.pinned ? "Unpinned." : "Pinned.")
            }
          >
            {thread.pinned ? <PinOffIcon aria-hidden /> : <PinIcon aria-hidden />}
            {thread.pinned ? "Unpin" : "Pin"}
          </Button>
          {question && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                thread.visibility === "private"
                  ? moderate(
                      { visibility: "public" },
                      "Every student can see it now. The author can no longer change it.",
                    )
                  : moderate({ visibility: "private" }, "Only the author and staff can see it now.")
              }
            >
              {thread.visibility === "private" ? "Make public" : "Make private"}
            </Button>
          )}
        </div>
      )}

      <section className="flex flex-col gap-3 border-t pt-3" aria-label="Replies">
        {thread.replies.length === 0 ? (
          <p className="text-muted-foreground">No replies yet.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {thread.replies.map((reply) => (
              <li
                key={reply.id}
                className={
                  reply.role === "student"
                    ? "rounded-lg border p-3"
                    : "rounded-lg border border-primary/40 bg-primary/5 p-3"
                }
              >
                <p className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                  <AuthorName author={reply.author} role={reply.role} />
                  <span>· {formatWhen(reply.created_at)}</span>
                  {reply.edited_at && <span title={formatWhen(reply.edited_at)}>· edited</span>}
                </p>
                {editing?.kind === "reply" && editing.id === reply.id ? (
                  <ReplyForm
                    initial={reply.body_md}
                    label="Edit reply"
                    submitLabel="Save"
                    pendingLabel="Saving…"
                    onCancel={() => setEditing(null)}
                    onSubmit={async (body) => {
                      const saved = await apply(() => updateReply(id, reply.id, body), "Reply saved.");
                      if (saved) setEditing(null);
                      return saved;
                    }}
                  />
                ) : (
                  <>
                    <MarkdownView source={reply.body_md} userContent />
                    {(reply.can_edit || reply.can_delete) && editing === null && (
                      <div className="mt-2 flex gap-2">
                        {reply.can_edit && (
                          <Button
                            variant="ghost"
                            size="xs"
                            disabled={busy}
                            onClick={() => setEditing({ kind: "reply", id: reply.id })}
                          >
                            Edit
                          </Button>
                        )}
                        {reply.can_delete && (
                          <Button
                            variant="ghost"
                            size="xs"
                            className="text-destructive"
                            disabled={busy}
                            onClick={() => setConfirm({ kind: "reply", id: reply.id })}
                          >
                            Delete
                          </Button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </li>
            ))}
          </ol>
        )}

        {permissions.reply && !full ? (
          <ReplyForm
            submitLabel="Send reply"
            pendingLabel="Sending…"
            onSubmit={(body) => apply(() => createReply(id, body), "Reply sent.")}
          />
        ) : full ? (
          <p className="text-muted-foreground">This thread has reached its reply limit.</p>
        ) : (
          thread.author.is_me &&
          question &&
          thread.visibility === "private" &&
          thread.status === "closed" && (
            <p className="text-muted-foreground">Staff closed this question.</p>
          )
        )}
      </section>

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === "thread" ? "Delete this thread?" : "Delete this reply?"}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === "thread"
                ? "The question or announcement and all its replies are removed for everyone."
                : "The reply is removed for everyone."}{" "}
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={confirmDelete}>
              {busy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}
