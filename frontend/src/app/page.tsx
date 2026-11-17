import type { Metadata } from "next";
import { Suspense } from "react";

import { Dashboard } from "@/components/home/dashboard";
import { LandingPage } from "@/components/landing/landing-page";
import { AppShell } from "@/components/nav/app-shell";
import { TopNavFallback } from "@/components/nav/top-nav";
import { currentSession } from "@/lib/current-session";

// "/" is the one page with two faces: the role dashboard when signed in, the
// public landing page otherwise. It picks one itself instead of proxy.ts
// rewriting to a separate route, because Next.js treats that rewrite as an
// external URL (its origin never matches the server's own) and fetches it
// over the forwarded protocol, which fails behind an HTTPS reverse proxy.

export async function generateMetadata(): Promise<Metadata> {
  const session = await currentSession();
  // Signed out: the root layout's default title "Flabsheet"
  return session.state === "valid" ? { title: "Home" } : {};
}

async function Home() {
  const session = await currentSession();
  // "unknown" (backend unreachable) shows the landing page, as signing in
  // can't work then anyway. proxy.ts already sent must_change_password away.
  if (session.state !== "valid") return <LandingPage />;
  return (
    <AppShell>
      <Dashboard />
    </AppShell>
  );
}

export default function RootPage() {
  return (
    // Both faces start with the same 48 px bar holding the wordmark
    <Suspense fallback={<TopNavFallback />}>
      <Home />
    </Suspense>
  );
}
