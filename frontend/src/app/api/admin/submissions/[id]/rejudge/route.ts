import { forwardWithId } from "@/lib/backend";

type Context = RouteContext<"/api/admin/submissions/[id]/rejudge">;

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return forwardWithId(request, id, (id) => `/admin/submissions/${id}/rejudge`);
}
