import { forwardToBackend } from "@/lib/backend";

export function PUT(request: Request) {
  return forwardToBackend(request, "/admin/settings/leaderboard");
}
