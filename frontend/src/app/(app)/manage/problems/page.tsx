import type { Metadata } from "next";

import { ProblemList } from "@/components/problems/problem-list";

export const metadata: Metadata = { title: "Problems" };

export default function ManageProblemsPage() {
  return <ProblemList />;
}
