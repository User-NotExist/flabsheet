import { verdictInfo } from "@/components/submissions/verdict-badge";
import type { SubmissionProgress } from "@/lib/api";
import { notifyInfo, notifySuccess } from "@/lib/notify";

/**
 * Toast for the final progress update of a submission, so a user who scrolled
 * away from the result panel still learns that judging ended:
 *
 *     if (isFinalStatus(update.status)) notifyJudged(update);
 *
 * Only "Accepted" is a success toast. Any other verdict is information about
 * the user's code, not a failure of the app, so it is never an error toast.
 */
export function notifyJudged(progress: SubmissionProgress): void {
  const label = progress.verdict ? verdictInfo(progress.verdict).label : "Under review";
  const message = `Submission #${progress.id}: ${label}.`;
  if (progress.verdict === "AC") notifySuccess(message);
  else notifyInfo(message);
}
