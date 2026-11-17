import { Suspense, type ReactNode } from "react";

import { TopNav, TopNavFallback } from "@/components/nav/top-nav";
import {
  InstanceSettingsProvider,
  KillswitchBanner,
} from "@/components/settings/instance-settings";

/**
 * Frame of every signed-in page: top nav, killswitch banner, then the page.
 * Used by the (app) layout and by the root page when it shows the dashboard.
 *
 *   <AppShell><Dashboard /></AppShell>
 */
export function AppShell({ children }: { children: ReactNode }) {
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
