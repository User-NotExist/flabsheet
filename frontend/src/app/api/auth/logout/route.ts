import { forwardToBackend } from "@/lib/backend";

export function POST(request: Request) {
  return forwardToBackend(request, "/auth/logout");
}
