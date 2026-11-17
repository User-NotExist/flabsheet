import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * One number on the dashboard. Pass `href` to make the whole card a link to
 * the page the number comes from.
 */
export function StatCard({
  label,
  value,
  detail,
  href,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  href?: string;
}) {
  const body = (
    <>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </div>
      {detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
    </>
  );
  const className = "rounded-xl bg-card px-4 py-3.5 ring-1 ring-foreground/10";
  if (!href) return <div className={className}>{body}</div>;
  return (
    <Link
      href={href}
      className={cn(className, "transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring")}
    >
      {body}
    </Link>
  );
}

/** A dashboard section: a heading, an optional action on the right, then the content. */
export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
