import { forwardWithSlug } from "@/lib/backend";

type Context = RouteContext<"/api/problems/[slug]/submissions">;

export async function POST(request: Request, context: Context) {
  const { slug } = await context.params;
  return forwardWithSlug(
    request,
    slug,
    (slug) => `/problems/${slug}/submissions`,
  );
}
