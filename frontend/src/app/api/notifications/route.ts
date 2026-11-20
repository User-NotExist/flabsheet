import { forwardToBackend } from "@/lib/backend";

export async function GET(request: Request) {
  return forwardToBackend(request, "/notifications");
}

/** `?read=true`: clear the read notifications. */
export async function DELETE(request: Request) {
  return forwardToBackend(request, "/notifications");
}
