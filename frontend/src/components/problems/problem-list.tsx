"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import {
  BuildBadge,
  StatusBadge,
  enableBlockedReason,
} from "@/components/problems/problem-badges";
import { buttonVariants } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  listLanguages,
  listProblems,
  setProblemState,
  type ProblemListItem,
} from "@/lib/api";
import { useApiError } from "@/lib/use-api-error";

const POLL_MS = 5000; // only while a build is pending

/** "C++20 (g++ 13)" → "C++20": the table has no room for the toolchain. */
function shortName(display: string): string {
  return display.replace(/\s*\(.*\)$/, "");
}

function formatUpdated(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  if (now.getTime() - date.getTime() < 60_000) return "Just now";
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.ceil((startOfToday.getTime() - date.getTime()) / 86_400_000);
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return date.toLocaleDateString();
}

export function ProblemList() {
  const toMessage = useApiError();
  const [problems, setProblems] = useState<ProblemListItem[] | null>(null);
  const [languageNames, setLanguageNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);

  // The router keeps this page mounted (hidden) after navigating away
  useLayoutEffect(() => {
    return () => {
      setError(null);
      setTogglingId(null);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    listProblems()
      .then((items) => {
        if (!cancelled) setProblems(items);
      })
      .catch((err) => {
        if (!cancelled) setError(toMessage(err));
      });
    listLanguages()
      .then((languages) => {
        if (cancelled) return;
        setLanguageNames(
          Object.fromEntries(languages.map((l) => [l.id, shortName(l.display)])),
        );
      })
      .catch(() => {
        // The table falls back to language ids
      });
    return () => {
      cancelled = true;
    };
  }, [toMessage]);

  const building = problems?.some((p) => p.build_status === "pending") ?? false;
  useEffect(() => {
    if (!building) return;
    let cancelled = false;
    const timer = setInterval(() => {
      listProblems()
        .then((items) => {
          if (!cancelled) setProblems(items);
        })
        .catch(() => {
          // A missed poll is retried by the next tick
        });
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [building]);

  async function toggle(problem: ProblemListItem, enable: boolean) {
    setTogglingId(problem.id);
    setError(null);
    try {
      const detail = await setProblemState(
        problem.id,
        enable ? "enable" : "disable",
      );
      setProblems(
        (items) =>
          items?.map((item) =>
            item.id === detail.id
              ? { ...item, status: detail.status, can_enable: detail.can_enable }
              : item,
          ) ?? null,
      );
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Problems</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every problem in this course. Students only see enabled ones.
          </p>
        </div>
        <Link
          href="/manage/problems/new"
          className={buttonVariants({ size: "lg" })}
        >
          New problem
        </Link>
      </div>

      <FormError message={error} />

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[46rem] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Problem</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5 font-medium">Build</th>
              <th className="px-3 py-2.5 font-medium">Languages</th>
              <th className="px-3 py-2.5 text-right font-medium">Submissions</th>
              <th className="px-3 py-2.5 font-medium">Updated</th>
              <th className="px-4 py-2.5 font-medium">Visible to students</th>
            </tr>
          </thead>
          <tbody>
            {problems === null && !error && (
              <tr>
                <td colSpan={7} role="status" className="px-4 py-8 text-center text-muted-foreground">
                  Loading problems…
                </td>
              </tr>
            )}
            {problems?.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  No problems yet. Create the first one with “New problem”.
                </td>
              </tr>
            )}
            {problems?.map((problem) => {
              const blocked = enableBlockedReason(
                problem.status,
                problem.can_enable,
                problem.build_status,
              );
              return (
                <tr key={problem.id} className="border-b last:border-b-0">
                  <td className="px-4 py-3">
                    <Link
                      href={`/manage/problems/${problem.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {problem.title}
                    </Link>
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge status={problem.status} />
                  </td>
                  <td className="px-3 py-3">
                    <BuildBadge status={problem.build_status} />
                  </td>
                  <td className="px-3 py-3 text-foreground/75">
                    {problem.languages
                      .map((id) => languageNames[id] ?? id)
                      .join(", ") || "—"}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {problem.submission_count}
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap text-foreground/75">
                    {formatUpdated(problem.updated_at)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <Switch
                        aria-label={`Show ${problem.title} to students`}
                        checked={problem.status === "enabled"}
                        disabled={blocked !== null || togglingId === problem.id}
                        onCheckedChange={(checked) => toggle(problem, checked)}
                      />
                      {blocked && (
                        <span className="text-xs whitespace-nowrap text-muted-foreground">
                          {blocked}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-sm text-muted-foreground">
        A problem can be enabled once a build has succeeded. While a later
        build is running or has failed, students keep the last good version.
        Disabling hides the problem from students and keeps every submission.
      </p>
    </main>
  );
}
