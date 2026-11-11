import { forwardWithId } from "@/lib/backend";

type Context = RouteContext<"/api/admin/problems/[id]/testdata">;

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return forwardWithId(request, id, (id) => `/admin/problems/${id}/testdata`);
}
