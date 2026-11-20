"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { createDataColumnHelper, DataTable } from "@/components/data-table/data-table";
import { SendNotificationButton } from "@/components/notifications/send-notification-dialog";
import { formatWhen } from "@/components/submissions/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  clearReadNotifications,
  deleteNotification,
  getSession,
  listNotifications,
  markAllNotificationsRead,
  setNotificationRead,
  type AppNotification,
  type NotificationPage,
  type NotificationType,
} from "@/lib/api";
import { announceNotificationsChanged } from "@/lib/notification-events";
import { notifyError, notifySuccess } from "@/lib/notify";
import { safeNextPath } from "@/lib/redirect";
import { useApiError } from "@/lib/use-api-error";

const TYPE_LABELS: Record<NotificationType, string> = {
  "clarification.answered": "Answer",
  "clarification.new": "Question",
  announcement: "Announcement",
  manual: "From staff",
};

type Paging = { pageIndex: number; pageSize: number };

type RowActions = {
  busy: boolean;
  toggle: (item: AppNotification) => void;
  dismiss: (item: AppNotification) => void;
};

const helper = createDataColumnHelper<AppNotification>();

function listColumns({ busy, toggle, dismiss }: RowActions) {
  return helper.columns([
    helper.display({
      id: "notification",
      header: "Notification",
      cell: ({ row: { original: item } }) => (
        <div className="flex min-w-64 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            {!item.is_read && (
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />
            )}
            <span className={item.is_read ? "" : "font-semibold"}>{item.title}</span>
            <Badge variant="outline">{TYPE_LABELS[item.type]}</Badge>
          </span>
          {item.body && (
            <span className="line-clamp-3 whitespace-pre-line text-muted-foreground">
              {item.body}
            </span>
          )}
          {item.link && (
            <Link
              href={safeNextPath(item.link)}
              onClick={() => !item.is_read && toggle(item)}
              className="w-fit text-primary underline-offset-4 hover:underline"
            >
              Open
            </Link>
          )}
        </div>
      ),
    }),
    helper.accessor("created_at", {
      header: "Received",
      cell: ({ getValue }) => formatWhen(getValue()),
      meta: { cellClassName: "whitespace-nowrap" },
    }),
    helper.display({
      id: "actions",
      header: "Actions",
      meta: { cellClassName: "py-2" },
      cell: ({ row: { original: item } }) => (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggle(item)}>
            {item.is_read ? "Mark unread" : "Mark read"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            disabled={busy}
            onClick={() => dismiss(item)}
          >
            Dismiss
          </Button>
        </div>
      ),
    }),
  ]);
}

/** /notifications: the caller's own notifications, newest first, paged by the backend. */
export function NotificationList() {
  const toMessage = useApiError();
  const [paging, setPaging] = useState<Paging>({ pageIndex: 0, pageSize: 25 });
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<NotificationPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [staff, setStaff] = useState(false);

  useLayoutEffect(() => () => {
    setError(null);
    setBusy(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((user) => {
        if (!cancelled) setStaff(user.role !== "student");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    listNotifications(paging.pageIndex + 1, paging.pageSize)
      .then((next) => {
        if (cancelled) return;
        setError(null);
        const lastPage = Math.max(0, Math.ceil(next.total / paging.pageSize) - 1);
        if (paging.pageIndex > lastPage) {
          // Dismissing the last rows of the last page
          setPaging((current) => ({ ...current, pageIndex: lastPage }));
          return;
        }
        setPage(next);
      })
      .catch((err) => {
        if (!cancelled) setError(toMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [paging, revision, toMessage]);

  const reload = useCallback(() => {
    setRevision((value) => value + 1);
    announceNotificationsChanged();
  }, []);

  /** Run a change, then re-read the page and tell the bell. */
  const run = useCallback(
    async (change: () => Promise<string | null>) => {
      setBusy(true);
      try {
        const done = await change();
        if (done) notifySuccess(done);
        reload();
      } catch (err) {
        notifyError(toMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [reload, toMessage],
  );

  const toggle = useCallback(
    (item: AppNotification) =>
      void run(async () => {
        await setNotificationRead(item.id, !item.is_read);
        return null;
      }),
    [run],
  );
  const dismiss = useCallback(
    (item: AppNotification) =>
      void run(async () => {
        await deleteNotification(item.id);
        return "Notification dismissed.";
      }),
    [run],
  );

  const columns = useMemo(() => listColumns({ busy, toggle, dismiss }), [busy, toggle, dismiss]);

  const total = page?.total ?? 0;
  const unread = page?.unread_count ?? 0;
  const read = total - unread;

  return (
    <main className="text-sm">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-7 sm:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
            <p className="mt-1 text-muted-foreground">
              Answers to your questions, announcements and messages from staff. They are removed
              after 90 days.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy || unread === 0}
              onClick={() =>
                run(async () => {
                  const n = await markAllNotificationsRead();
                  return `Marked ${n} as read.`;
                })
              }
            >
              Mark all read
            </Button>
            <Button
              variant="outline"
              disabled={busy || read <= 0}
              onClick={() =>
                run(async () => {
                  const n = await clearReadNotifications();
                  return `Cleared ${n} read ${n === 1 ? "notification" : "notifications"}.`;
                })
              }
            >
              Clear read
            </Button>
            {staff && <SendNotificationButton variant="default" />}
          </div>
        </header>

        <section className="min-w-0">
          {error && (
            <div className="mb-3 flex items-center gap-2">
              <FormError message={error} />
              <Button variant="outline" onClick={() => setRevision((value) => value + 1)}>
                Retry
              </Button>
            </div>
          )}
          <p role="status" className="mb-3 text-muted-foreground">
            {page && `${total} ${total === 1 ? "notification" : "notifications"}, ${unread} unread`}
          </p>
          <DataTable
            label="Notifications"
            data={page?.items ?? null}
            columns={columns}
            getRowId={(item) => item.id}
            serverPages={{
              total,
              pageIndex: paging.pageIndex,
              pageSize: paging.pageSize,
              onChange: setPaging,
            }}
            loadingText={error ? "Could not load notifications." : "Loading notifications…"}
            emptyText="No notifications."
            className="min-w-[36rem]"
          />
        </section>
      </div>
    </main>
  );
}
