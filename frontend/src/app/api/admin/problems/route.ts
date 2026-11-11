import { forwardToBackend } from "@/lib/backend";

export function GET(request: Request) {
  return forwardToBackend(request, "/admin/problems");
}

export function POST(request: Request) {
  return forwardToBackend(request, "/admin/problems");
}
