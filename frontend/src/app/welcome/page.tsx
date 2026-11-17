import type { Metadata } from "next";

import { LandingPage } from "@/components/landing/landing-page";

// No title: the browser shows the default "Flabsheet". proxy.ts serves this
// page at "/" to signed-out visitors and sends signed-in users to "/".
export const metadata: Metadata = {
  description:
    "Solve programming problems in the browser and get them judged automatically.",
};

export default function WelcomePage() {
  return <LandingPage />;
}
