"use client";

import { useEffect, useEffectEvent } from "react";

import {
  getSubmission,
  isFinalStatus,
  submissionStreamUrl,
  type SubmissionProgress,
} from "@/lib/api";

const POLL_MS = 3000;
// EventSource reconnects by itself; after this many failures in a row the
// stream is given up for polling (a proxy that buffers or cuts SSE).
const MAX_STREAM_FAILURES = 2;

/**
 * Follows a submission while it is judged (FR-STD-07).
 *
 * Calls `onProgress` with each status update from the Server-Sent Events
 * stream, and stops by itself at the final one. If the stream keeps failing
 * it polls the submission every 3 s instead. Pass `null` to follow nothing.
 *
 *     useSubmissionProgress(judging ? submission.id : null, (progress) => {
 *       setProgress(progress);
 *       if (isFinalStatus(progress.status)) reload();
 *     });
 */
export function useSubmissionProgress(
  id: number | null,
  onProgress: (progress: SubmissionProgress) => void,
): void {
  const report = useEffectEvent(onProgress);

  useEffect(() => {
    if (id === null) return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const source = new EventSource(submissionStreamUrl(id));

    const stop = () => {
      stopped = true;
      source.close();
      clearInterval(timer);
    };
    const deliver = (progress: SubmissionProgress) => {
      if (stopped) return;
      if (isFinalStatus(progress.status)) stop();
      report(progress);
    };

    const poll = () => {
      getSubmission(id, { studentView: true })
        .then((submission) =>
          deliver({
            id: submission.id,
            status: submission.status,
            tests_done: submission.results.length,
            verdict: submission.verdict,
            score_milli: submission.score_milli,
          }),
        )
        .catch(() => {
          // A missed poll is retried by the next tick
        });
    };

    source.onmessage = (event) => {
      failures = 0;
      try {
        deliver(JSON.parse(event.data) as SubmissionProgress);
      } catch {
        // Not a progress message; the next one replaces it anyway
      }
    };
    source.onerror = () => {
      failures += 1;
      if (stopped || failures < MAX_STREAM_FAILURES) return;
      source.close();
      if (timer === undefined) {
        poll();
        timer = setInterval(poll, POLL_MS);
      }
    };

    return stop;
  }, [id]);
}
