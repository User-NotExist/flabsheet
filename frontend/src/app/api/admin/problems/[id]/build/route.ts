import { forwardWithId } from "@/lib/backend";

type Context = RouteContext<"/api/admin/problems/[id]/build">;

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return forwardWithId(request, id, (id) => `/admin/problems/${id}/build`);
}

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return forwardWithId(request, id, (id) => `/admin/problems/${id}/build`);
}
