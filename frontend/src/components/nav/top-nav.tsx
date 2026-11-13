import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";

import { AccountMenu } from "@/components/nav/account-menu";
import { NavLinks } from "@/components/nav/nav-links";
import { QueueCount } from "@/components/nav/queue-count";
import { ServerClock } from "@/components/nav/server-clock";
import { navItemsFor } from "@/lib/navigation";
import { checkSession, SESSION_COOKIE } from "@/lib/session";

function NavBar({ children }: { children?: ReactNode }) {
  return (
    <header className="border-b bg-background">
      <nav className="mx-auto flex h-12 items-stretch gap-6 px-4 sm:px-6">
        <Link
          href="/"
          className="flex shrink-0 items-center text-base font-semibold tracking-tight"
        >
          Flabsheet
        </Link>
        {children}
      </nav>
    </header>
  );
}

/** Shown while the session is being looked up. */
export function TopNavFallback() {
  return <NavBar />;
}

/** Top bar with the pages the signed-in user's role may open. */
export async function TopNav() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await checkSession(token);
  // proxy.ts already redirected signed-out users; this only covers a
  // backend hiccup between the two lookups.
  if (session.state !== "valid") return <NavBar />;

  const { user } = session;
  const items = navItemsFor(user.role);

  return (
    <NavBar>
      <NavLinks items={items} />
      <div className="ml-auto flex shrink-0 items-center gap-6 text-sm">
        <ServerClock />
        <QueueCount />
        <AccountMenu user={user} />
      </div>
    </NavBar>
  );
}
