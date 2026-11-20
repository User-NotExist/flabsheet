import { forwardWithObjectIds } from "@/lib/backend";

type Context = RouteContext<"/api/clarifications/[id]/replies/[replyId]">;

const path = ([id, reply]: string[]) => `/clarifications/${id}/replies/${reply}`;

export async function PATCH(request: Request, context: Context) {
  const { id, replyId } = await context.params;
  return forwardWithObjectIds(request, [id, replyId], path);
}

export async function DELETE(request: Request, context: Context) {
  const { id, replyId } = await context.params;
  return forwardWithObjectIds(request, [id, replyId], path);
}
