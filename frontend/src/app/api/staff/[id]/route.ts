import { forwardWithId } from "@/lib/backend";

export async function PATCH(request: Request, context: RouteContext<"/api/staff/[id]">) {
  const { id } = await context.params;
  return forwardWithId(request, id, (safe) => `/staff/${safe}`);
}
