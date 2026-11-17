"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { createDataColumnHelper, DataTable } from "@/components/data-table/data-table";
import { formatPoints, formatWhen, shortLanguage } from "@/components/submissions/format";
import { VerdictBadge } from "@/components/submissions/verdict-badge";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type AdminSubmissionItem,
  type AdminSubmissionPage,
  listAllSubmissions,
  listProblems,
  type ProblemListItem,
  rejudgeSubmission,
  requeueSubmission,
  type SubmissionFilters,
  type SubmissionStatus,
  submissionsCsvUrl,
} from "@/lib/api";
import { notifyError, notifySuccess } from "@/lib/notify";
import { useApiError } from "@/lib/use-api-error";

const PAGE_SIZE = 50;
const ALL = "all";
// Filtered on the stored judge verdict, so PA (a display-only label) is not offered
const VERDICTS = ["AC", "WA", "PE", "TLE", "MLE", "OLE", "RE", "CE", "SE", "JE"];

const STATUS_LABELS: Record<SubmissionStatus, string> = {
  queued: "Queued",
  compiling: "Compiling",
  running: "Running",
  done: "Done",
  delayed: "Delayed",
  review: "Needs review",
};

/** "2026-11-14" -> the next local midnight as ISO, so the "To" day is included. */
function endOfDay(date: string): string {
  const next = new Date(`${date}T00:00`);
  next.setDate(next.getDate() + 1);
  return next.toISOString();
}

const helper = createDataColumnHelper<AdminSubmissionItem>();

// Module scope: a new column list on every render would rebuild the row models
const dataColumns = helper.columns([
  helper.accessor("id", {
    header: "ID",
    sortFn: "basic",
    cell: ({ getValue }) => (
      <Link href={`/submissions/${getValue()}`} className="font-medium hover:underline">
        #{getValue()}
      </Link>
    ),
  }),
  helper.accessor("created_at", {
    header: "Submitted",
    sortFn: "text",
    cell: ({ getValue }) => formatWhen(getValue()),
    meta: { cellClassName: "text-muted-foreground" },
  }),
  helper.accessor((s) => s.student.display_name, {
    id: "student",
    header: "Student",
    sortFn: "text",
    cell: ({ row: { original: s } }) => (
      <span>
        {s.student.display_name}
        {s.is_staff && <span className="text-muted-foreground"> (staff test)</span>}
        <span className="block font-mono text-xs text-muted-foreground">{s.student.login_id}</span>
      </span>
    ),
  }),
  helper.accessor((s) => s.problem.title, {
    id: "problem",
    header: "Problem",
    sortFn: "text",
  }),
  helper.accessor((s) => shortLanguage(s.language.display), {
    id: "language",
    header: "Language",
    sortFn: "text",
    meta: { cellClassName: "text-muted-foreground" },
  }),
  helper.display({
    id: "result",
    header: "Result",
    cell: ({ row: { original: s } }) =>
      s.verdict ? (
        <VerdictBadge verdict={s.verdict} />
      ) : (
        <Badge variant="secondary">{STATUS_LABELS[s.status]}</Badge>
      ),
  }),
  helper.accessor("score_milli", {
    header: "Score",
    sortFn: "basic",
    meta: { align: "right" },
    cell: ({ getValue }) => {
      const score = getValue();
      return score === null ? "–" : formatPoints(score);
    },
  }),
]);

export function SubmissionBrowser() {
  const toMessage = useApiError();
  const [problems, setProblems] = useState<ProblemListItem[]>([]);
  const [studentInput, setStudentInput] = useState("");
  const [student, setStudent] = useState("");
  const [problem, setProblem] = useState(ALL);
  const [verdict, setVerdict] = useState(ALL);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AdminSubmissionPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  // Id of the submission whose Rejudge or Requeue request is in flight
  const [sending, setSending] = useState<number | null>(null);

  // The router keeps this page mounted (hidden) after navigating away
  useLayoutEffect(() => {
    return () => setSending(null);
  }, []);

  const columns = useMemo(() => {
    async function judgeAgain(item: AdminSubmissionItem) {
      setSending(item.id);
      try {
        await (item.status === "delayed" ? requeueSubmission : rejudgeSubmission)(item.id);
        setRevision((r) => r + 1);
        notifySuccess(
          item.status === "delayed"
            ? `Submission #${item.id} is back in the queue.`
            : `Rejudging submission #${item.id}.`,
        );
      } catch (err) {
        notifyError(toMessage(err));
      } finally {
        setSending(null);
      }
    }
    return [
      ...dataColumns,
      // Only the rows that wait for staff: a judge error (FR-MON-06) and a
      // delayed job (FR-JDG-05). Any other one is rejudged from its own page.
      helper.display({
        id: "action",
        header: "Action",
        cell: ({ row: { original: s } }) =>
          s.status === "review" || s.status === "delayed" ? (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              disabled={sending !== null}
              onClick={() => judgeAgain(s)}
            >
              {s.status === "delayed"
                ? sending === s.id
                  ? "Requeueing…"
                  : "Requeue"
                : sending === s.id
                  ? "Rejudging…"
                  : "Rejudge"}
            </Button>
          ) : null,
      }),
    ];
  }, [sending, toMessage]);

  // Problem names for the filter; the list still works without them
  useEffect(() => {
    let cancelled = false;
    listProblems()
      .then((items) => {
        if (!cancelled) setProblems(items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Wait until typing stops before asking the server
  useEffect(() => {
    const timer = setTimeout(() => {
      setStudent(studentInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [studentInput]);

  const filters = useMemo<SubmissionFilters>(
    () => ({
      student: student || undefined,
      problem: problem === ALL ? undefined : problem,
      verdict: verdict === ALL ? undefined : verdict,
      date_from: from ? new Date(`${from}T00:00`).toISOString() : undefined,
      date_to: to ? endOfDay(to) : undefined,
    }),
    [student, problem, verdict, from, to],
  );

  useEffect(() => {
    let cancelled = false;
    listAllSubmissions(filters, page, PAGE_SIZE)
      .then((data) => {
        if (cancelled) return;
        setResult(data);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(toMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [filters, page, revision, toMessage]);

  function clear() {
    setStudentInput("");
    setStudent("");
    setProblem(ALL);
    setVerdict(ALL);
    setFrom("");
    setTo("");
    setPage(1);
  }

  const total = result?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstRow = (page - 1) * PAGE_SIZE + 1;

  return (
    <main className="min-h-[calc(100vh-3rem)] bg-muted/30 text-sm">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-7 sm:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Submissions</h1>
            <p className="mt-1 text-muted-foreground">Every submission, newest first. Open one to see its source and full results.</p>
          </div>
          <a
            href={submissionsCsvUrl(filters)}
            download
            className={buttonVariants({ variant: "outline" })}
            onClick={() => notifySuccess("Export started. The CSV file will download shortly.")}
          >
            Export this list as CSV
          </a>
        </header>

        <section
          aria-label="Filters"
          className="grid grid-cols-1 items-end gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto_auto_auto]"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="filter-student">Student</Label>
            <Input
              id="filter-student"
              placeholder="Student ID"
              autoComplete="off"
              value={studentInput}
              onChange={(event) => setStudentInput(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="filter-problem">Problem</Label>
            <Select
              items={[
                { value: ALL, label: "All problems" },
                ...problems.map((p) => ({ value: p.slug, label: p.title })),
              ]}
              value={problem}
              onValueChange={(value) => {
                if (value) {
                  setProblem(value);
                  setPage(1);
                }
              }}
            >
              <SelectTrigger id="filter-problem" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All problems</SelectItem>
                {problems.map((p) => (
                  <SelectItem key={p.id} value={p.slug}>
                    {p.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="filter-verdict">Verdict</Label>
            <Select
              items={[
                { value: ALL, label: "Any verdict" },
                ...VERDICTS.map((v) => ({ value: v, label: v })),
              ]}
              value={verdict}
              onValueChange={(value) => {
                if (value) {
                  setVerdict(value);
                  setPage(1);
                }
              }}
            >
              <SelectTrigger id="filter-verdict" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Any verdict</SelectItem>
                {VERDICTS.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="filter-from">From</Label>
            <Input
              id="filter-from"
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="filter-to">To</Label>
            <Input
              id="filter-to"
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <Button variant="link" onClick={clear}>
            Clear
          </Button>
        </section>

        <section className="flex flex-col gap-3">
          {error && (
            <div className="flex items-center gap-2">
              <FormError message={error} />
              <Button variant="outline" onClick={() => setRevision((r) => r + 1)}>
                Retry
              </Button>
            </div>
          )}
          <DataTable
            label="Submissions"
            data={result?.items ?? null}
            columns={columns}
            getRowId={(s) => String(s.id)}
            paginate={false}
            loadingText={error ? "Could not load submissions." : "Loading submissions…"}
            emptyText="No submissions match these filters."
          />
          {result && total > 0 && (
            <div className="flex flex-wrap items-center justify-end gap-2 text-muted-foreground">
              <span role="status" className="tabular-nums">
                {firstRow}–{firstRow + result.items.length - 1} of {total}
              </span>
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Judge errors (JE) do not count toward a student&apos;s score until a rejudge resolves them. Staff test submissions are tagged and excluded from scores.
          </p>
        </section>
      </div>
    </main>
  );
}