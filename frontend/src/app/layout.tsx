import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import { Suspense } from "react";
import "./globals.css";

import { ThemeSync } from "@/components/theme/theme-sync";
import { Toaster } from "@/components/ui/sonner";
import { requestOrigin } from "@/lib/request-origin";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// The link preview card for messaging apps. openGraph and twitter leave out
// title and description on purpose: Next.js then fills them from each page's
// own ("Sign in · Flabsheet"). The image is ./opengraph-image.tsx. Crawlers are
// signed out, so proxy.ts sends them from any protected page to /login, and
// only the public pages ever show up in a card.
export async function generateMetadata(): Promise<Metadata> {
  return {
    // og:image must be absolute. Without this, Next.js falls back to
    // http://localhost:<port>, which no messaging app can fetch.
    metadataBase: await requestOrigin(),
    title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
    description: SITE_DESCRIPTION,
    openGraph: { type: "website", siteName: SITE_NAME },
    twitter: { card: "summary_large_image" },
  };
}

// generateMetadata reads request headers, and Next.js refuses that on a page
// whose content is otherwise fully prerenderable unless the page also says it
// renders at request time. This renders nothing; inside <Suspense> it leaves
// each page's static shell intact. Link crawlers still get the tags in <head>:
// Next.js waits for metadata for bots (htmlLimitedBots).
async function RequestTimeMarker() {
  await connection();
  return null;
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The inline script adds `.dark` before hydration, so the class differs
    // from this JSX on purpose
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Runs while the HTML is parsed: a dark-theme user never sees a light flash */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeSync />
        {children}
        <Toaster position="bottom-right" />
        <Suspense>
          <RequestTimeMarker />
        </Suspense>
      </body>
    </html>
  );
}
