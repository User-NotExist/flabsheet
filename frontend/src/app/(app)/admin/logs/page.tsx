import type { Metadata } from "next";

import { LogViewer } from "@/components/logs/log-viewer";

export const metadata: Metadata = { title: "Logs" };

export default function LogsPage() {
  return <LogViewer />;
}
