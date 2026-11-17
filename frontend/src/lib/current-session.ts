/**
 * The session of the current request, for Server Components. Memoized per
 * request, so a page and its generateMetadata share one backend lookup.
 *
 *   const session = await currentSession(); // SessionCheck
 *
 * Reads cookies, so callers must render inside a <Suspense> boundary.
 */

import { cookies } from "next/headers";
import { connection } from "next/server";
import { cache } from "react";

import { checkSession, SESSION_COOKIE } from "@/lib/session";

export const currentSession = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  // Hold the lookup back until a real request, not the runtime-prefetch
  // stage (see TopNav for the clock-read error this avoids)
  await connection();
  return checkSession(token);
});
