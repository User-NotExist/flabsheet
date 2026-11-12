"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { getQueueCount } from "@/lib/api";

const REFRESH_MS = 10_000;

/**
 * How many submissions, from everyone, are waiting for the judge. Re-read
 * every 10 s while the tab is visible, and hidden when the count cannot be
 * read: a stale number would be worse than none.
 */
export function QueueCount() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      // A background tab would only add load; it catches up when shown again
      if (document.hidden) return;
      getQueueCount()
        .then((queued) => {
          if (!cancelled) setCount(queued);
        })
        .catch(() => {
          // Signed out or backend down: the page itself reports that
          if (!cancelled) setCount(null);
        });
    };

    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  if (count === null) return null;
  return (
    <Badge
      variant="secondary"
      title="Submissions waiting to be judged."
      className="h-8 px-2.5 font-normal text-muted-foreground"
    >
      System Queue:
      <span className="font-medium text-foreground tabular-nums">{count}</span>
    </Badge>
  );
}
