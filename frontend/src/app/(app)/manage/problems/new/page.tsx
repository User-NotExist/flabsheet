import type { Metadata } from "next";

import { NewProblemForm } from "@/components/problems/new-problem-form";

export const metadata: Metadata = { title: "New problem" };

export default function NewProblemPage() {
  return <NewProblemForm />;
}
