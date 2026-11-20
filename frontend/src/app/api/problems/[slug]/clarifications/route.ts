import { forwardWithSlug } from "@/lib/backend";

type Context = RouteContext<"/api/problems/[slug]/clarifications">;

export async function GET(request: Request, context: Context) {
  const { slug } = await context.params;
  return forwardWithSlug(request, slug, (slug) => `/problems/${slug}/clarifications`);
}

export async function POST(request: Request, context: Context) {
  const { slug } = await context.params;
  return forwardWithSlug(request, slug, (slug) => `/problems/${slug}/clarifications`);
}
