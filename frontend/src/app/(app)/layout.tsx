import { Suspense } from "react";

import { TopNav, TopNavFallback } from "@/components/nav/top-nav";

/** Signed-in pages: everything except /login and /change-password. */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      {/* Reads the session cookie, so it streams in behind the boundary */}
      <Suspense fallback={<TopNavFallback />}>
        <TopNav />
      </Suspense>
      {children}
    </>
  );
}
