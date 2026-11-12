import type { Metadata } from "next";

import { SolveList } from "@/components/solve/solve-list";

export const metadata: Metadata = { title: "Problems" };

export default function ProblemsPage() {
  return <SolveList />;
}
