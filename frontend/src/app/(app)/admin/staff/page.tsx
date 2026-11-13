import type { Metadata } from "next";

import { StaffManager } from "@/components/staff/staff-manager";

export const metadata: Metadata = { title: "Staff accounts" };

export default function StaffPage() {
  return <StaffManager />;
}
