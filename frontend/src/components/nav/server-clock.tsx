"use client";

import { useEffect, useState } from "react";

import { getServerTime } from "@/lib/api";

// The clock runs by itself between syncs; this only corrects drift
const RESYNC_MS = 5 * 60_000;

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

type Clock = { epochMs: number; utcOffsetMinutes: number };

/** "UTC", "UTC+7" or "UTC-3:30". */
function zoneLabel(utcOffsetMinutes: number): string {
  if (utcOffsetMinutes === 0) return "UTC";
  const sign = utcOffsetMinutes < 0 ? "-" : "+";
  const hours = Math.floor(Math.abs(utcOffsetMinutes) / 60);
  const minutes = Math.abs(utcOffsetMinutes) % 60;
  const tail = minutes ? `:${String(minutes).padStart(2, "0")}` : "";
  return `UTC${sign}${hours}${tail}`;
}

/**
 * The server's date and time, in the server's time zone. Submission times
 * and limits follow that clock, and the browser's may be wrong or in another
 * zone, so the time is read from the backend and only counted on here.
 * Hidden until the first answer: a guessed time would be worse than none.
 */
export function ServerClock() {
  const [clock, setClock] = useState<Clock | null>(null);

  useEffect(() => {
    let cancelled = false;
    let tickTimer: ReturnType<typeof setTimeout> | undefined;
    // The last answer, and the monotonic time it arrived at. Counting from
    // performance.now() keeps the clock right when the user's own clock is
    // changed.
    let synced: {
      epochMs: number;
      utcOffsetMinutes: number;
      at: number;
    } | null = null;

    const tick = () => {
      if (!synced) return;
      const epochMs = synced.epochMs + (performance.now() - synced.at);
      setClock({ epochMs, utcOffsetMinutes: synced.utcOffsetMinutes });
      // Wake up on the next full second, so the seconds never skip or stall
      tickTimer = setTimeout(tick, 1000 - (epochMs % 1000) + 1);
    };

    const sync = () => {
      // A background tab would only add load; it catches up when shown
      // again, which also corrects a clock that slept with the computer
      if (document.hidden) return;
      const sentAt = performance.now();
      getServerTime()
        .then((time) => {
          if (cancelled) return;
          const receivedAt = performance.now();
          synced = {
            // The answer is about half a round trip old when it arrives
            epochMs: time.epochMs + (receivedAt - sentAt) / 2,
            utcOffsetMinutes: time.utcOffsetMinutes,
            at: receivedAt,
          };
          clearTimeout(tickTimer);
          tick();
        })
        .catch(() => {
          // Signed out or backend down: keep counting from the last answer
        });
    };

    sync();
    const syncTimer = setInterval(sync, RESYNC_MS);
    document.addEventListener("visibilitychange", sync);
    return () => {
      cancelled = true;
      clearTimeout(tickTimer);
      clearInterval(syncTimer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  if (!clock) return null;
  const zone = zoneLabel(clock.utcOffsetMinutes);
  // Shifted by the server's offset and printed as UTC, which gives the
  // server's wall clock whatever the browser's zone is
  const wall = new Date(clock.epochMs + clock.utcOffsetMinutes * 60_000);
  return (
    <time
      dateTime={new Date(clock.epochMs).toISOString()}
      title={`Server time (${zone}).`}
      className="hidden items-center gap-2 whitespace-nowrap text-muted-foreground tabular-nums md:flex"
    >
      <span className="hidden lg:inline">{DATE_FORMAT.format(wall)}</span>
      <span className="font-medium text-foreground">
        {TIME_FORMAT.format(wall)}
      </span>
      <span className="text-xs">{zone}</span>
    </time>
  );
}
