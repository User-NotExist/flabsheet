import { Suspense } from "react";

import { TopNav, TopNavFallback } from "@/components/nav/top-nav";
import {
  InstanceSettingsProvider,
  KillswitchBanner,
} from "@/components/settings/instance-settings";

/** Signed-in pages: everything except /login and /change-password. */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      {/* Reads the session cookie, so it streams in behind the boundary */}
      <Suspense fallback={<TopNavFallback />}>
        <TopNav />
      </Suspense>
      {/* Kept beside the nav, not around it: as a child of this client
          provider, TopNav's session lookup fails the prerender check */}
      <InstanceSettingsProvider>
        <KillswitchBanner />
        {children}
      </InstanceSettingsProvider>
    </>
  );
}
