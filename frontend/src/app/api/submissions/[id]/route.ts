import { forwardWithId } from "@/lib/backend";

type Context = RouteContext<"/api/submissions/[id]">;

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return forwardWithId(request, id, (id) => `/submissions/${id}`);
}
