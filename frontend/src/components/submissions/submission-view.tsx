"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { CodeEditor } from "@/components/problems/code-editor";
import { formatScore, formatWhen } from "@/components/submissions/format";
import { LiveStatus } from "@/components/submissions/live-status";
import { ResultReport, resultNotice } from "@/components/submissions/result-report";
import { VerdictBadge } from "@/components/submissions/verdict-badge";
import { WhitespaceToggle } from "@/components/submissions/whitespace-text";
import { Button } from "@/components/ui/button";
import {
  getSession,
  getSubmission,
  isFinalStatus,
  type Submission,
  type SubmissionProgress,
} from "@/lib/api";
import { writeDraft, writeLanguage } from "@/lib/drafts";
import { useSubmissionProgress } from "@/lib/sse";
import { useApiError } from "@/lib/use-api-error";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 sm:p-6">
      {children}
    </main>
  );
}

/** Shown while the route's id is resolved and the submission loads. */
export function SubmissionViewFallback() {
  return (
    <Shell>
      <p role="status" className="text-sm text-muted-foreground">
        Loading submission…
      </p>
    </Shell>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="rounded-lg bg-info px-3.5 py-2.5 text-sm text-info-foreground">
      {children}
    </p>
  );
}

/**
 * One submission's full report at /submissions/[id] (FR-STD-08, FR-MON-02).
 * A student sees their own; staff see anyone's, with the checker messages and
 * test data of hidden tests. The backend decides which: this page draws what
 * it is given.
 */
export function SubmissionView() {
  const router = useRouter();
  const toMessage = useApiError();
  const id = Number(useParams<{ id: string }>().id);

  const [submission, setSubmission] = useState<Submission | null>(null);
  const [progress, setProgress] = useState<SubmissionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = follow the problem's checking mode
  const [whitespace, setWhitespace] = useState<boolean | null>(null);

  // The router keeps this page mounted (hidden) after navigating away
  useLayoutEffect(() => {
    return () => setError(null);
  }, []);

  const load = useCallback(
    (isCancelled: () => boolean = () => false) => {
      getSubmission(id)
        .then((loaded) => {
          if (!isCancelled()) setSubmission(loaded);
        })
        .catch((err) => {
          if (!isCancelled()) setError(toMessage(err));
        });
    },
    [id, toMessage],
  );

  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  const judging = submission !== null && !isFinalStatus(submission.status);
  useSubmissionProgress(judging ? id : null, (update) => {
    setProgress(update);
    if (isFinalStatus(update.status)) load();
  });

  if (error && !submission) {
    return (
      <Shell>
        <FormError message={error} />
        <Link href="/problems" className="w-fit text-sm text-muted-foreground hover:text-foreground">
          ← All problems
        </Link>
      </Shell>
    );
  }
  if (!submission) return <SubmissionViewFallback />;

  const { problem, staff_view: staffView } = submission;
  const live = progress?.id === submission.id && judging ? progress : null;
  const status = live?.status ?? submission.status;
  const testsDone = live?.tests_done ?? submission.results.length;
  const passed = submission.results.filter((r) => r.verdict === "AC").length;
  const showWhitespace = whitespace ?? submission.checker_strict;
  const notice = resultNotice(submission);

  async function loadIntoEditor() {
    if (!submission) return;
    try {
      const user = await getSession();
      writeDraft(user.id, problem.slug, submission.language.id, submission.source);
      writeLanguage(user.id, problem.slug, submission.language.id);
      router.push(`/problems/${problem.slug}`);
    } catch (err) {
      setError(toMessage(err));
    }
  }

  return (
    <Shell>
      <Link
        href={`/problems/${problem.slug}`}
        className="w-fit text-sm text-muted-foreground hover:text-foreground"
      >
        ← Back to {problem.title}
      </Link>

      <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-5">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {staffView ? "Submission" : "Your submission"} #{submission.id}
          </h1>
          <p className="text-sm text-muted-foreground">
            {problem.title}
            {staffView && ` (version ${problem.version})`} · {submission.language.display} ·{" "}
            {formatWhen(submission.created_at)}
            {staffView && ` · attempt ${submission.attempt}`}
          </p>
          {submission.author && (
            <p className="text-sm text-muted-foreground">
              {submission.author.display_name} · {submission.author.login_id}
              {submission.is_staff && " · staff test"}
            </p>
          )}
        </div>
        {judging ? (
          <LiveStatus status={status} testsDone={testsDone} testsTotal={submission.tests_total} />
        ) : (
          <div className="flex items-center gap-4">
            {submission.verdict && <VerdictBadge verdict={submission.verdict} long />}
            <span className="text-2xl font-semibold tabular-nums">
              {formatScore(submission.score_milli, submission.max_points)}
            </span>
          </div>
        )}
      </section>

      <FormError message={error} />
      {notice && <Banner>{notice}</Banner>}
      {!notice && submission.is_current && !staffView && (
        <Banner>
          This is your latest submission for this problem, so it sets your current score.
        </Banner>
      )}
      {submission.is_staff && (
        <Banner>
          Staff test submission: it is judged like a student&apos;s, but never counts on the
          leaderboard, progress or exports.
        </Banner>
      )}
      {staffView && (
        <Banner>
          Staff view: checker messages and the input and expected output of hidden tests are
          shown below. Students never see these. The program&apos;s output on hidden tests is
          not kept.
        </Banner>
      )}
      {staffView && submission.judge_reason && (
        <p className="rounded-lg bg-muted px-3.5 py-2.5 text-sm">
          Judge reason: <span className="font-mono text-[0.8rem]">{submission.judge_reason}</span>
        </p>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold">
              Test results
              {!judging && submission.results.length > 0 && (
                <> · {passed} of {submission.tests_total} passed</>
              )}
            </h2>
            {submission.results.length > 0 && submission.verdict !== "CE" && (
              <WhitespaceToggle checked={showWhitespace} onChange={setWhitespace} />
            )}
          </div>
          {judging ? (
            <p className="text-sm text-muted-foreground">
              The results appear here when judging is done.
            </p>
          ) : (
            <ResultReport submission={submission} showWhitespace={showWhitespace} layout="cards" />
          )}
        </section>

        <div className="flex min-w-0 flex-col gap-5">
          <section className="flex flex-col gap-3 rounded-xl border bg-card p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">
                {staffView ? `Source · ${submission.source_name}` : "Your code"}
              </h2>
              <Button type="button" variant="link" size="sm" onClick={loadIntoEditor}>
                Load into editor
              </Button>
            </div>
            <CodeEditor
              value={submission.source}
              onChange={() => {}}
              languageId={submission.language.id}
              ariaLabel="Submitted code"
              readOnly
            />
          </section>

          {staffView && submission.verdict !== "CE" && (
            <section className="flex flex-col gap-3 rounded-xl border bg-card p-5">
              <h2 className="text-base font-semibold">Compiler log</h2>
              <pre className="max-h-64 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-[0.8rem] whitespace-pre-wrap">
                {submission.compile_log || "(empty: compiled without messages)"}
              </pre>
            </section>
          )}
        </div>
      </div>
    </Shell>
  );
}
