import type { Metadata } from "next";

import { Dashboard } from "@/components/home/dashboard";

export const metadata: Metadata = { title: "Home" };

/** Signed-in home. Signed-out visitors get the landing page here (proxy.ts). */
export default function HomePage() {
  return <Dashboard />;
}
