import type { Metadata } from "next";
import { Suspense } from "react";

import { SolvePage, SolvePageFallback } from "@/components/solve/solve-page";

export const metadata: Metadata = { title: "Problem" };

export default function ProblemPage() {
  return (
    // The page reads the slug from the URL, which is only known at request
    // time, so it renders behind a boundary (cacheComponents)
    <Suspense fallback={<SolvePageFallback />}>
      <SolvePage />
    </Suspense>
  );
}
