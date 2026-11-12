import type { Metadata } from "next";

import { StudentManager } from "@/components/students/student-manager";

export const metadata: Metadata = { title: "Students" };

export default function StudentsPage() {
  return <StudentManager />;
}
