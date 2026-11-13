import { forwardWithId } from "@/lib/backend";

export async function POST(request: Request, context: RouteContext<"/api/staff/[id]/reset-password">) {
  const { id } = await context.params;
  return forwardWithId(request, id, (safe) => `/staff/${safe}/reset-password`);
}
