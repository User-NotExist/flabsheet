import type { Metadata } from "next";

import { ClarificationQueue } from "@/components/clarifications/clarification-queue";

export const metadata: Metadata = { title: "Clarifications" };

export default function ClarificationsPage() {
  return <ClarificationQueue />;
}
