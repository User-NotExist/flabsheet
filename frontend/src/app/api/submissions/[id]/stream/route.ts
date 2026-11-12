import { forwardToBackend, numericId } from "@/lib/backend";

type Context = RouteContext<"/api/submissions/[id]/stream">;

export async function GET(request: Request, context: Context) {
  const id = numericId((await context.params).id);
  if (id === null) {
    return Response.json({ detail: "Not found" }, { status: 404 });
  }
  // Server-Sent Events: the response stays open until judging ends
  return forwardToBackend(request, `/submissions/${id}/stream`, {
    stream: true,
  });
}
