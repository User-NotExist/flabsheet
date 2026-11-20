import { forwardWithObjectIds } from "@/lib/backend";

type Context = RouteContext<"/api/clarifications/[id]/replies">;

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return forwardWithObjectIds(request, [id], ([id]) => `/clarifications/${id}/replies`);
}
