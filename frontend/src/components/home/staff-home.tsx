"use client";

import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { Section, StatCard } from "@/components/home/stat-card";
import { formatFrozenAt } from "@/components/leaderboard/format";
import { useInstanceSettings } from "@/components/settings/instance-settings";
import {
  getQueueCount,
  listProblems,
  listStudents,
  type LeaderboardMode,
  type ProblemListItem,
  type UserRole,
} from "@/lib/api";
import { navItemsFor } from "@/lib/navigation";
import { useApiError } from "@/lib/use-api-error";

// One line per nav section (keyed by NavItem.href) for the quick links
const SECTION_TEXT: Record<string, string> = {
  "/problems": "Write statements, upload test data and build packages.",
  "/manage/students": "Create student accounts and reset passwords.",
  "/manage/progress": "Every student's score on every problem, with CSV export.",
  "/manage/submissions": "Browse, inspect and rejudge submissions.",
  "/leaderboard": "Live standings, and what students see.",
  "/admin/staff": "Create and manage staff accounts.",
  "/admin/settings": "Open or close submissions for everyone.",
  "/admin/logs": "Who did what, and when.",
};

const MODE_LABELS: Record<LeaderboardMode, string> = {
  live: "Live",
  hidden: "Hidden",
  frozen: "Frozen",
};

type Counts = { problems: ProblemListItem[]; students: number };

/** The staff and admin overview: course state at a glance, then the sections. */
export function StaffHome({ role }: { role: UserRole }) {
  const toMessage = useApiError();
  const { settings } = useInstanceSettings();
  const [counts, setCounts] = useState<Counts | null>(null);
  const [queued, setQueued] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    return () => setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listProblems(), listStudents()])
      .then(([problems, students]) => {
        if (!cancelled) setCounts({ problems, students: students.length });
      })
      .catch((err) => {
        if (!cancelled) setError(toMessage(err));
      });
    // Also shown in the top bar; a failure here is not worth an error
    getQueueCount()
      .then((n) => {
        if (!cancelled) setQueued(n);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [toMessage]);

  const problems = counts?.problems;
  const byStatus = (status: ProblemListItem["status"]) =>
    problems?.filter((p) => p.status === status).length ?? 0;
  const failedBuilds = problems?.filter((p) => p.build_status === "failed").length ?? 0;
  const loading = counts === null ? (error ? "–" : "…") : null;

  const submissionsValue = settings ? (settings.submissions_open ? "Open" : "Closed") : "…";
  const leaderboardDetail =
    settings?.leaderboard_mode === "frozen" && settings.leaderboard_frozen_at
      ? `Since ${formatFrozenAt(settings.leaderboard_frozen_at)}.`
      : "What students see.";

  return (
    <>
      <FormError message={error} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard
          label="Enabled problems"
          href="/manage/problems"
          value={loading ?? byStatus("enabled")}
          detail={
            problems
              ? [
                  `${byStatus("draft")} draft, ${byStatus("disabled")} disabled`,
                  failedBuilds > 0 ? `${failedBuilds} failed build${failedBuilds === 1 ? "" : "s"}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : undefined
          }
        />
        <StatCard
          label="Students"
          href="/manage/students"
          value={loading ?? counts?.students}
        />
        <StatCard
          label="Waiting to be judged"
          href="/manage/submissions"
          value={queued ?? "…"}
          detail="Submissions from everyone."
        />
        <StatCard
          label="Submissions"
          href={role === "admin" ? "/admin/settings" : undefined}
          value={submissionsValue}
          detail={
            settings && !settings.submissions_open
              ? (settings.submissions_message ?? "Closed by an admin.")
              : "Students can submit."
          }
        />
        <StatCard
          label="Leaderboard"
          href="/manage/leaderboard"
          value={settings ? MODE_LABELS[settings.leaderboard_mode] : "…"}
          detail={leaderboardDetail}
        />
      </div>

      <Section title="Go to">
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {navItemsFor(role).map((link) => (
            <li key={link.section}>
              <Link
                href={link.href}
                className="flex h-full items-center gap-3 rounded-xl bg-card px-4 py-3.5 ring-1 ring-foreground/10 transition-colors hover:bg-muted/60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{link.label}</span>
                  {SECTION_TEXT[link.section] && (
                    <span className="mt-0.5 block text-sm text-muted-foreground">
                      {SECTION_TEXT[link.section]}
                    </span>
                  )}
                </span>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
