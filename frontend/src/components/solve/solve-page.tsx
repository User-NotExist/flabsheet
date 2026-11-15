"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { CodeEditor } from "@/components/problems/code-editor";
import { MarkdownView } from "@/components/problems/markdown-view";
import { StatusBadge } from "@/components/problems/problem-badges";
import { useInstanceSettings } from "@/components/settings/instance-settings";
import {
  formatLimit,
  formatScore,
  formatWhen,
  shortLanguage,
} from "@/components/submissions/format";
import { LiveStatus } from "@/components/submissions/live-status";
import { ResultReport, resultNotice } from "@/components/submissions/result-report";
import { VerdictBadge } from "@/components/submissions/verdict-badge";
import { WhitespaceText, WhitespaceToggle } from "@/components/submissions/whitespace-text";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
  ApiError,
  MAX_SOURCE_BYTES,
  getSession,
  getSolveProblem,
  getSubmission,
  isFinalStatus,
  listMySubmissions,
  submitSolution,
  type SolveProblem,
  type Submission,
  type SubmissionListItem,
  type SubmissionProgress,
} from "@/lib/api";
import { readDraft, readLanguage, writeDraft, writeLanguage } from "@/lib/drafts";
import { useSubmissionProgress } from "@/lib/sse";
import { useApiError } from "@/lib/use-api-error";

// Same limits as the backend (FR-STD-06); it enforces them, these only
// explain a disabled button before the request is made
const SUBMIT_INTERVAL_MS = 10_000;
const MAX_ACTIVE_SUBMISSIONS = 3;
// FR-ADM-05: Submit comes back within 5 s of the killswitch being turned off
const SETTINGS_REFRESH_MS = 5000;

const encoder = new TextEncoder();

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto grid w-full max-w-7xl items-start gap-5 p-4 sm:p-6 lg:grid-cols-2">
      {children}
    </main>
  );
}

/** Shown while the route's slug is resolved and the problem loads. */
export function SolvePageFallback() {
  return (
    <Shell>
      <p role="status" className="text-sm text-muted-foreground">
        Loading problem…
      </p>
    </Shell>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <Badge variant="secondary" className="h-6 px-2.5 font-normal">
      {children}
    </Badge>
  );
}

function listItem(submission: Submission): SubmissionListItem {
  return {
    id: submission.id,
    language: submission.language,
    status: submission.status,
    verdict: submission.verdict,
    score_milli: submission.score_milli,
    max_points: submission.max_points,
    is_staff: submission.is_staff,
    created_at: submission.created_at,
  };
}

/**
 * The problem page at /problems/[slug] (FR-STD-04 to 09): statement and
 * samples on the left; editor, Submit, the latest result and the viewer's
 * history on the right.
 *
 * Staff and admins get the same page as a preview (FR-PRB-14): it is drawn by
 * the same components from the same student-shaped responses, so it cannot
 * drift from what students see. Only the wording around it differs.
 */
export function SolvePage() {
  const toMessage = useApiError();
  const slug = useParams<{ slug: string }>().slug;
  const { settings, refresh: refreshSettings } = useInstanceSettings();

  const [problem, setProblem] = useState<SolveProblem | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  const [history, setHistory] = useState<SubmissionListItem[]>([]);
  // The submission in the result panel: the newest one
  const [latest, setLatest] = useState<Submission | null>(null);
  const [progress, setProgress] = useState<SubmissionProgress | null>(null);
  const [language, setLanguage] = useState("");
  const [source, setSource] = useState("");
  const [draftSaved, setDraftSaved] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // null = follow the problem's checking mode
  const [whitespace, setWhitespace] = useState<boolean | null>(null);
  const coolTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // The router keeps this page mounted (hidden) after navigating away
  useLayoutEffect(() => {
    return () => {
      setError(null);
      setSubmitting(false);
      setConfirmOpen(false);
      setCooling(false);
      clearTimeout(coolTimer.current);
    };
  }, []);

  // Runs again each time the page is shown. The draft is re-read too, because
  // "Load into editor" on a submission page may have replaced it meanwhile.
  useEffect(() => {
    let cancelled = false;
    Promise.all([getSolveProblem(slug), getSession(), listMySubmissions(slug)])
      .then(async ([loaded, user, items]) => {
        if (cancelled) return;
        const remembered = readLanguage(user.id, slug);
        const chosen =
          loaded.languages.find((l) => l.id === remembered)?.id ??
          loaded.languages[0]?.id ??
          "";
        setProblem(loaded);
        setUserId(user.id);
        setHistory(items);
        setLanguage(chosen);
        setSource(readDraft(user.id, slug, chosen));
        const newest = items[0]
          ? await getSubmission(items[0].id, { studentView: true })
          : null;
        if (!cancelled) setLatest(newest);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(toMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [slug, toMessage]);

  useEffect(() => {
    const timer = setInterval(refreshSettings, SETTINGS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshSettings]);

  /** After a result is final: the report, the history and the current score. */
  const reload = useCallback(
    (submissionId: number) => {
      Promise.all([
        getSubmission(submissionId, { studentView: true }),
        listMySubmissions(slug),
        getSolveProblem(slug),
      ])
        .then(([submission, items, loaded]) => {
          setLatest((current) => (current?.id === submission.id ? submission : current));
          setHistory(items);
          setProblem(loaded);
        })
        .catch(() => {
          // The panel keeps the live status; reloading the page shows the report
        });
    },
    [slug],
  );

  const judging = latest !== null && !isFinalStatus(latest.status);
  useSubmissionProgress(judging ? latest.id : null, (update) => {
    setProgress(update);
    if (isFinalStatus(update.status)) reload(update.id);
  });

  if (loadError) {
    return (
      <Shell>
        <div className="flex flex-col gap-3">
          <FormError message={loadError} />
          <Link href="/problems" className="w-fit text-sm text-muted-foreground hover:text-foreground">
            ← All problems
          </Link>
        </div>
      </Shell>
    );
  }
  if (!problem || userId === null) return <SolvePageFallback />;

  const preview = problem.preview;
  const showWhitespace = whitespace ?? problem.checker_strict;
  const sourceBytes = encoder.encode(source).length;
  const closed = settings !== null && !settings.submissions_open;
  const active = history.filter(
    (item) => item.status === "queued" || item.status === "compiling" || item.status === "running",
  ).length;
  const full =
    problem.score_milli !== null && problem.score_milli >= problem.max_points * 1000;

  // Why Submit is disabled, in the order a user can act on it
  const blocked = closed
    ? "Submissions are closed."
    : problem.status === "archived"
      ? "This problem is archived."
      : source.trim() === ""
        ? "Write some code to submit."
        : sourceBytes > MAX_SOURCE_BYTES
          ? `Your code is larger than ${MAX_SOURCE_BYTES / 1024} KB.`
          : active >= MAX_ACTIVE_SUBMISSIONS
            ? `${MAX_ACTIVE_SUBMISSIONS} of your submissions are still being judged.`
            : cooling
              ? "You can submit again in a few seconds."
              : null;

  function editSource(next: string) {
    setSource(next);
    setDraftSaved(writeDraft(userId!, slug, language, next));
  }

  function chooseLanguage(next: string) {
    setLanguage(next);
    writeLanguage(userId!, slug, next);
    setSource(readDraft(userId!, slug, next));
  }

  /** Puts code into the editor as the draft of its language. */
  function loadCode(languageId: string, code: string) {
    const allowed = problem!.languages.some((l) => l.id === languageId);
    const target = allowed ? languageId : language;
    setLanguage(target);
    writeLanguage(userId!, slug, target);
    setSource(code);
    setDraftSaved(writeDraft(userId!, slug, target, code));
  }

  async function loadSubmission(id: number) {
    setError(null);
    try {
      const submission = await getSubmission(id, { studentView: true });
      loadCode(submission.language.id, submission.source);
    } catch (err) {
      setError(toMessage(err));
    }
  }

  async function submit() {
    setConfirmOpen(false);
    setSubmitting(true);
    setError(null);
    try {
      const submission = await submitSolution(slug, language, source);
      setLatest(submission);
      setProgress(null);
      setHistory((items) => [listItem(submission), ...items]);
      setCooling(true);
      clearTimeout(coolTimer.current);
      coolTimer.current = setTimeout(() => setCooling(false), SUBMIT_INTERVAL_MS);
    } catch (err) {
      // The killswitch was turned on since the last refresh: show the banner now
      if (err instanceof ApiError && err.code === "submissions_closed") refreshSettings();
      setError(toMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const live = judging && progress?.id === latest.id ? progress : null;
  const notice = latest ? resultNotice(latest) : null;

  return (
    <>
      {preview && (
        // Inverted bar in the light theme only: inverted in the dark theme it is a
        // glaring white strip, and the outline button's white label vanishes on it
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-foreground px-4 py-3 text-sm text-background sm:px-6 dark:border-b dark:bg-card dark:text-card-foreground">
          <p className="min-w-0 flex-1 basis-80">
            <span className="font-semibold">Preview as student.</span> This is exactly what
            students see. Your submissions here are judged but never count on the leaderboard,
            progress or exports.
          </p>
          <StatusBadge status={problem.status} />
          <Link
            href={`/manage/problems/${problem.id}`}
            className={buttonVariants({ variant: "outline", className: "text-foreground" })}
          >
            Back to editor
          </Link>
        </div>
      )}
      <Shell>
        <article className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5">
          {!preview && (
            <Link href="/problems" className="w-fit text-sm text-muted-foreground hover:text-foreground">
              ← All problems
            </Link>
          )}
          <h1 className="text-2xl font-semibold tracking-tight">{problem.title}</h1>
          <div className="flex flex-wrap gap-2">
            <Chip>{problem.max_points} points</Chip>
            <Chip>
              Time:{" "}
              {problem.languages
                .map((l) => `${shortLanguage(l.display)} ${formatLimit(l.time_limit_ms)}`)
                .join(" · ")}
            </Chip>
            <Chip>Memory: {problem.memory_limit_mb} MB</Chip>
            {problem.checker_strict && (
              <Badge variant="secondary" className="h-6 bg-info px-2.5 text-info-foreground">
                Strict output: spacing must match
              </Badge>
            )}
          </div>

          <MarkdownView source={problem.statement_md} />

          {problem.samples.length > 0 && (
            <section className="flex flex-col gap-4 border-t pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold">
                  {problem.samples.length === 1 ? "Sample" : "Samples"}
                </h2>
                <WhitespaceToggle checked={showWhitespace} onChange={setWhitespace} />
              </div>
              {problem.samples.map((sample, index) => (
                <div key={sample.ordinal} className="flex flex-col gap-2">
                  {problem.samples.length > 1 && (
                    <h3 className="text-sm font-medium">Sample {index + 1}</h3>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <span className="text-xs text-muted-foreground">Input</span>
                      <WhitespaceText
                        text={sample.input}
                        showWhitespace={showWhitespace}
                        truncated={sample.input_truncated}
                      />
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <span className="text-xs text-muted-foreground">Expected output</span>
                      <WhitespaceText
                        text={sample.expected}
                        showWhitespace={showWhitespace}
                        truncated={sample.expected_truncated}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </section>
          )}
        </article>

        <div className="flex min-w-0 flex-col gap-5">
          <section className="flex flex-col gap-3 rounded-xl border bg-card p-5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Label htmlFor="language">Language</Label>
              <Select
                items={problem.languages.map((l) => ({ value: l.id, label: l.display }))}
                value={language}
                onValueChange={(id) => {
                  if (id) chooseLanguage(id);
                }}
              >
                <SelectTrigger id="language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {problem.languages.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.display}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {problem.reference && (
                <Button
                  type="button"
                  variant="link"
                  onClick={() =>
                    loadCode(problem.reference!.language_id, problem.reference!.source)
                  }
                >
                  Load reference solution
                </Button>
              )}
              <span
                className={`ml-auto text-xs tabular-nums ${
                  sourceBytes > MAX_SOURCE_BYTES ? "text-destructive" : "text-muted-foreground"
                }`}
              >
                {draftSaved ? "Draft saved in this browser" : "Draft not saved"} ·{" "}
                {(sourceBytes / 1024).toFixed(1)} / {MAX_SOURCE_BYTES / 1024} KB
              </span>
            </div>
            <CodeEditor
              value={source}
              onChange={editSource}
              languageId={language}
              ariaLabel="Your code"
            />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button
                type="button"
                size="lg"
                className="px-4"
                disabled={blocked !== null || submitting}
                onClick={() => (full && !preview ? setConfirmOpen(true) : submit())}
              >
                {submitting ? "Submitting…" : preview ? "Submit as test" : "Submit"}
              </Button>
              <p className="min-w-0 flex-1 basis-56 text-sm text-muted-foreground">
                {blocked ??
                  (preview
                    ? "Staff test: judged, not scored."
                    : "Your latest submission sets your score, even if it is lower.")}
              </p>
            </div>
            <FormError message={error} />
          </section>

          {latest && (
            <section
              className="flex flex-col gap-4 rounded-xl border bg-card p-5"
              aria-live="polite"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <h2 className="text-base font-semibold">
                  {preview ? "Latest test result" : "Latest result"}
                </h2>
                {!judging && latest.verdict && <VerdictBadge verdict={latest.verdict} long />}
                {preview && <Chip>Not counted</Chip>}
                <span className="ml-auto text-lg font-semibold tabular-nums">
                  {formatScore(judging ? null : latest.score_milli, latest.max_points)}
                </span>
              </div>
              {judging ? (
                <LiveStatus
                  status={live?.status ?? latest.status}
                  testsDone={live?.tests_done ?? latest.results.length}
                  testsTotal={latest.tests_total}
                />
              ) : (
                <>
                  {notice && (
                    <p role="status" className="rounded-lg bg-info px-3.5 py-2.5 text-sm text-info-foreground">
                      {notice}
                    </p>
                  )}
                  <ResultReport submission={latest} showWhitespace={showWhitespace} layout="table" />
                  {latest.results.some((r) => r.visibility === "hidden") && (
                    <p className="text-sm text-muted-foreground">
                      Hidden tests show the verdict only.
                    </p>
                  )}
                </>
              )}
              <Link
                href={`/submissions/${latest.id}`}
                className="w-fit text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                {preview
                  ? "Open full staff view of this submission"
                  : "Open the full report"}
              </Link>
            </section>
          )}

          <section className="flex flex-col gap-2 rounded-xl border bg-card p-5">
            <h2 className="text-base font-semibold">
              {preview ? "Your test submissions" : "Your submissions"}
            </h2>
            {history.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing submitted yet. Your submissions to this problem appear here.
              </p>
            ) : (
              <ul className="flex flex-col">
                {history.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2.5 text-sm last:border-b-0"
                  >
                    <Link
                      href={`/submissions/${item.id}`}
                      className="font-semibold tabular-nums underline-offset-4 hover:underline"
                    >
                      #{item.id}
                    </Link>
                    <span className="text-muted-foreground">
                      {formatWhen(item.created_at)} · {shortLanguage(item.language.display)}
                    </span>
                    {item.verdict && isFinalStatus(item.status) ? (
                      <VerdictBadge verdict={item.verdict} />
                    ) : (
                      <span className="text-muted-foreground">
                        {item.status === "delayed" ? "Delayed" : "Judging…"}
                      </span>
                    )}
                    <span className="ml-auto whitespace-nowrap text-muted-foreground tabular-nums">
                      {preview ? "Not counted" : formatScore(item.score_milli, item.max_points)}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => loadSubmission(item.id)}
                    >
                      Load code
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </Shell>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace your full score?</DialogTitle>
            <DialogDescription>
              You already have {formatScore(problem.score_milli, problem.max_points)} on this
              problem. Your latest submission sets your score, so if this one scores lower, the
              lower score replaces it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={submit}>
              Submit anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
