import { forwardToBackend } from "@/lib/backend";

export async function GET(request: Request) {
  return forwardToBackend(request, "/clarifications");
}

export async function POST(request: Request) {
  return forwardToBackend(request, "/clarifications");
}
