import type { Metadata } from "next";
import { Suspense } from "react";

import {
  ProblemEditor,
  ProblemEditorFallback,
} from "@/components/problems/problem-editor";

export const metadata: Metadata = { title: "Problem editor" };

export default function ProblemEditorPage() {
  return (
    // The editor reads the id from the URL, which is only known at request
    // time, so it renders behind a boundary (cacheComponents)
    <Suspense fallback={<ProblemEditorFallback />}>
      <ProblemEditor />
    </Suspense>
  );
}
