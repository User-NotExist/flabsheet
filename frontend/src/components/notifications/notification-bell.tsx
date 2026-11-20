"use client";

import { BellIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useState } from "react";

import { formatWhen } from "@/components/submissions/format";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  setNotificationRead,
  type AppNotification,
} from "@/lib/api";
import { announceNotificationsChanged, onNotificationsChanged } from "@/lib/notification-events";
import { notifyError } from "@/lib/notify";
import { safeNextPath } from "@/lib/redirect";

// A reply is not urgent enough to poll faster; focus and changes on the
// page refresh it at once
const REFRESH_MS = 30_000;
const LATEST = 10;

/**
 * The bell in the top bar: the unread count, re-read every 30 s while the tab
 * is visible, when the window gets focus and when the /notifications page
 * changes something. Opening it loads the latest 10. Like `QueueCount`, it
 * hides the number when it cannot be read rather than show a stale one.
 */
export function NotificationBell() {
  const router = useRouter();
  const pathname = usePathname();
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [failed, setFailed] = useState(false);

  // The layout stays mounted (hidden) across navigations: close the menu
  useLayoutEffect(() => () => setOpen(false), [pathname]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (document.hidden) return;
      getUnreadCount()
        .then((unread) => {
          if (!cancelled) setCount(unread);
        })
        .catch(() => {
          // Signed out or backend down: the page itself reports that
          if (!cancelled) setCount(null);
        });
    };

    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    const unsubscribe = onNotificationsChanged(refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      unsubscribe();
    };
  }, []);

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    listNotifications(1, LATEST)
      .then((page) => {
        setItems(page.items);
        setCount(page.unread_count);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }

  function follow(item: AppNotification) {
    if (!item.is_read) {
      setItems((current) =>
        current && current.map((n) => (n.id === item.id ? { ...n, is_read: true } : n)),
      );
      setCount((current) => (current ? current - 1 : current));
      setNotificationRead(item.id, true)
        .then(announceNotificationsChanged)
        .catch(() => {});
    }
    // Links come from the backend, which accepts only paths on this site
    if (item.link) router.push(safeNextPath(item.link));
  }

  async function readAll() {
    try {
      await markAllNotificationsRead();
      setItems((current) => current && current.map((n) => ({ ...n, is_read: true })));
      setCount(0);
      announceNotificationsChanged();
    } catch {
      notifyError("Could not mark the notifications read. Please try again.");
    }
  }

  const unread = count ?? 0;

  return (
    <DropdownMenu open={open} onOpenChange={openChange}>
      <DropdownMenuTrigger
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        className="relative flex size-8 items-center justify-center rounded-lg text-foreground/75 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-muted data-popup-open:text-foreground"
      >
        <BellIcon aria-hidden className="size-4" />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.65rem] leading-none font-semibold text-primary-foreground tabular-nums"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <div className="flex items-center justify-between gap-2 px-1.5 py-1">
          <p className="text-sm font-medium">Notifications</p>
          {unread > 0 && (
            <button
              type="button"
              onClick={readAll}
              className="text-xs text-primary underline-offset-4 hover:underline"
            >
              Mark all read
            </button>
          )}
        </div>
        <DropdownMenuSeparator />
        {failed ? (
          <p className="px-1.5 py-2 text-sm text-muted-foreground">Could not load notifications.</p>
        ) : items === null ? (
          <p className="px-1.5 py-2 text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="px-1.5 py-2 text-sm text-muted-foreground">Nothing new.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {items.map((item) => (
              <DropdownMenuItem
                key={item.id}
                onClick={() => follow(item)}
                className="flex flex-col items-start gap-0.5"
              >
                <span className="flex w-full items-start gap-2">
                  {!item.is_read && (
                    <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
                  )}
                  <span className={item.is_read ? "text-muted-foreground" : "font-medium"}>
                    {item.title}
                    {!item.is_read && <span className="sr-only"> (unread)</span>}
                  </span>
                </span>
                {item.body && (
                  <span className="line-clamp-2 text-xs text-muted-foreground">{item.body}</span>
                )}
                <span className="text-xs text-muted-foreground">{formatWhen(item.created_at)}</span>
              </DropdownMenuItem>
            ))}
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/notifications" />}>All notifications</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
