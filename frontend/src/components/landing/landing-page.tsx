import {
  ActivityIcon,
  CodeIcon,
  ShieldCheckIcon,
  TrophyIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";

import { SignedOutToast } from "@/components/landing/signed-out-toast";
import { VerdictBadge } from "@/components/submissions/verdict-badge";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: CodeIcon,
    title: "Code in the browser",
    text: "Read the statement and write your solution side by side. Drafts are saved as you type.",
  },
  {
    icon: ShieldCheckIcon,
    title: "Automatic judging",
    text: "Every submission runs in an isolated sandbox against the course's test cases.",
  },
  {
    icon: ActivityIcon,
    title: "Track your progress",
    text: "See your score on each problem, with a clear report for every test.",
  },
  {
    icon: TrophyIcon,
    title: "Leaderboard",
    text: "Compare standings with your class while your staff keep it open.",
  },
];

// Made-up results for the preview panel; the badges are the real ones
const SAMPLE_TESTS: { name: string; verdict: string; time: string }[] = [
  { name: "Sample 1", verdict: "AC", time: "4 ms" },
  { name: "Sample 2", verdict: "AC", time: "3 ms" },
  { name: "Test 3", verdict: "WA", time: "6 ms" },
  { name: "Test 4", verdict: "TLE", time: "1000 ms" },
];

const SAMPLE_CODE = `#include <iostream>

int main() {
    long long a, b;
    std::cin >> a >> b;
    std::cout << a + b << "\\n";
}`;

/** A glimpse of the problem page: a code editor and a result report. */
function PreviewPanel() {
  return (
    <div
      aria-hidden
      className="w-full overflow-hidden rounded-xl bg-card text-sm shadow-sm ring-1 ring-foreground/10"
    >
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-muted-foreground/30" />
        <span className="size-2.5 rounded-full bg-muted-foreground/30" />
        <span className="size-2.5 rounded-full bg-muted-foreground/30" />
        <span className="ml-2 text-xs text-muted-foreground">main.cpp · C++20</span>
      </div>
      <pre className="overflow-x-auto bg-muted/40 px-4 py-3 font-mono text-xs leading-relaxed text-foreground/85">
        {SAMPLE_CODE}
      </pre>
      <div className="border-t px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-medium">Result</span>
          <span className="tabular-nums text-muted-foreground">50 / 100</span>
        </div>
        <ul className="divide-y">
          {SAMPLE_TESTS.map((test) => (
            <li key={test.name} className="flex items-center gap-3 py-1.5">
              <span className="flex-1 text-foreground/80">{test.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {test.time}
              </span>
              <VerdictBadge verdict={test.verdict} className="w-11 justify-center" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The public front page that signed-out visitors see at "/". */
export function LandingPage() {
  return (
    <>
      <SignedOutToast />
      <header className="border-b bg-background">
        <div className="mx-auto flex h-12 items-center gap-3 px-4 sm:px-6">
          <Link href="/" className="text-base font-semibold tracking-tight">
            Flabsheet
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <Link href="/login" className={buttonVariants({ size: "sm" })}>
              Sign in
            </Link>
          </div>
        </div>
      </header>

      <main className="flex flex-1 flex-col">
        <section className="mx-auto grid w-full max-w-5xl items-center gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.1fr_1fr] md:py-20">
          <div className="flex flex-col items-start gap-5">
            <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              Practice programming, judged in seconds.
            </h1>
            <p className="max-w-prose text-base text-muted-foreground text-pretty">
              Solve your course&apos;s problems right in the browser. Submit
              your code and watch each test case pass as it is judged.
            </p>
            <Link
              href="/login"
              className={cn(buttonVariants({ size: "lg" }), "h-11 px-6 font-semibold")}
            >
              Sign in
            </Link>
            <p className="text-sm text-muted-foreground">
              Accounts are created by your course staff.
            </p>
          </div>
          <PreviewPanel />
        </section>

        <section
          aria-labelledby="features-heading"
          className="mx-auto w-full max-w-5xl px-4 pb-16 sm:px-6"
        >
          <h2 id="features-heading" className="sr-only">
            Features
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <li
                key={title}
                className="flex flex-col gap-2 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
              >
                <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-5" aria-hidden />
                </span>
                <h3 className="font-medium">{title}</h3>
                <p className="text-sm text-muted-foreground">{text}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t bg-background px-4 py-4 text-center text-xs text-muted-foreground sm:px-6">
        Flabsheet: problems, automatic judging and progress for one programming course.
      </footer>
    </>
  );
}
