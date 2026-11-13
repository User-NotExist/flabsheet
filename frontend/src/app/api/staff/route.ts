import { forwardToBackend } from "@/lib/backend";

export function GET(request: Request) {
  return forwardToBackend(request, "/staff");
}

export function POST(request: Request) {
  return forwardToBackend(request, "/staff");
}
