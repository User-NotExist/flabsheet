import { forwardToBackend } from "@/lib/backend";

export function GET(request: Request) {
  return forwardToBackend(request, "/settings/time");
}
