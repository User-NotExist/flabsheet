import { forwardWithObjectIds } from "@/lib/backend";

type Context = RouteContext<"/api/notifications/[id]">;

const path = ([id]: string[]) => `/notifications/${id}`;

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return forwardWithObjectIds(request, [id], path);
}

export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return forwardWithObjectIds(request, [id], path);
}
