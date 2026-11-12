import { forwardToBackend } from "@/lib/backend";

export function POST(request: Request) {
  // Hashing a class set of passwords can exceed the normal request timeout.
  return forwardToBackend(request, "/students/import", { stream: true });
}
