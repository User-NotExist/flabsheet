import type { Metadata } from "next";
import { Suspense } from "react";

import {
  SubmissionView,
  SubmissionViewFallback,
} from "@/components/submissions/submission-view";

export const metadata: Metadata = { title: "Submission" };

export default function SubmissionPage() {
  return (
    // The view reads the id from the URL, which is only known at request
    // time, so it renders behind a boundary (cacheComponents)
    <Suspense fallback={<SubmissionViewFallback />}>
      <SubmissionView />
    </Suspense>
  );
}
