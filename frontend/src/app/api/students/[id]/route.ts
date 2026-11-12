import { forwardWithId } from "@/lib/backend";

export async function PATCH(request: Request, context: RouteContext<"/api/students/[id]">) {
  const { id } = await context.params;
  return forwardWithId(request, id, (safe) => `/students/${safe}`);
}
