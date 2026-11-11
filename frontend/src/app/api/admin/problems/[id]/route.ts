import { forwardWithId } from "@/lib/backend";

type Context = RouteContext<"/api/admin/problems/[id]">;

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return forwardWithId(request, id, (id) => `/admin/problems/${id}`);
}

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return forwardWithId(request, id, (id) => `/admin/problems/${id}`);
}

export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return forwardWithId(request, id, (id) => `/admin/problems/${id}`);
}
