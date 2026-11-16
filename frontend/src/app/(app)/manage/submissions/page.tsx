import type { Metadata } from "next";

import { SubmissionBrowser } from "@/components/submissions/submission-browser";

export const metadata: Metadata = { title: "Submissions" };

export default function ManageSubmissionsPage() {
  return <SubmissionBrowser />;
}