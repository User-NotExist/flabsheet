import type { Metadata } from "next";

import { ProgressMatrix } from "@/components/progress/progress-matrix";

export const metadata: Metadata = { title: "Progress" };

export default function ManageProgressPage() {
  return <ProgressMatrix />;
}
