"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";

import { ApiError } from "@/lib/api";

/**
 * Turns a failed API call into the message to show.
 *
 * Returns null after starting a redirect to the login page (the session
 * expired), so callers show nothing in that case:
 *
 *     const toMessage = useApiError();
 *     try { await save(); } catch (err) { setError(toMessage(err)); }
 */
export function useApiError(): (error: unknown) => string | null {
  const router = useRouter();
  const pathname = usePathname();

  return useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        return null;
      }
      return error instanceof ApiError
        ? error.message
        : "Something went wrong. Please try again.";
    },
    [router, pathname],
  );
}
