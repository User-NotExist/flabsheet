import type { Metadata } from "next";

import { ClarificationQueue } from "@/components/clarifications/clarification-queue";
import { SendNotificationButton } from "@/components/notifications/send-notification-dialog";

export const metadata: Metadata = { title: "Clarifications" };

export default function ClarificationsPage() {
  return <ClarificationQueue actions={<SendNotificationButton />} />;
}
