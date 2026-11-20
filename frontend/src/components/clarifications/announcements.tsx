"use client";

import { PinIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { AuthorName } from "@/components/clarifications/badges";
import { MarkdownView } from "@/components/problems/markdown-view";
import { formatWhen } from "@/components/submissions/format";
import { buttonVariants } from "@/components/ui/button";
import { listAnnouncements, type ClarificationListItem } from "@/lib/api";
import { useApiError } from "@/lib/use-api-error";

// The dashboard shows the latest few; staff see all of them in the queue
const SHOWN = 5;

/**
 * Course-wide announcements on the dashboard, pinned first. It is the target
 * of their notifications (`/#announcements`). Students see nothing when there
 * are none; staff get a link to post one.
 */
export function Announcements({ staff = false }: { staff?: boolean }) {
  const toMessage = useApiError();
  const [items, setItems] = useState<ClarificationListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => () => setError(null), []);

  // Runs again when the dashboard is shown, so a new announcement appears
  useEffect(() => {
    let cancelled = false;
    listAnnouncements()
      .then((found) => {
        if (cancelled) return;
        setItems(found);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(toMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [toMessage]);

  if (!staff && !error && (items === null || items.length === 0)) return null;

  return (
    <section id="announcements" className="flex scroll-mt-6 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight">Announcements</h2>
        {staff && (
          <Link
            href="/manage/clarifications"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Manage
          </Link>
        )}
      </div>
      <FormError message={error} />
      {items?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No course-wide announcements. Post one from Clarifications.
        </p>
      )}
      {items && items.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {items.slice(0, SHOWN).map((item) => (
            <li key={item.id} className="flex flex-col gap-1.5 px-4 py-3 text-sm">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {item.pinned && (
                  <PinIcon aria-label="Pinned" className="size-3.5 text-muted-foreground" />
                )}
                <span className="font-medium break-words">{item.title}</span>
                <span className="text-muted-foreground">
                  · <AuthorName author={item.author} /> · {formatWhen(item.created_at)}
                </span>
              </p>
              <MarkdownView source={item.body_md} userContent />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
