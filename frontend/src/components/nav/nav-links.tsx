"use client";

import { cn } from "cn";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { isUnder } from "@/lib/navigation";

type Item = { label: string; href: string };

export function NavLinks({ items }: { items: Item[] }) {
  const pathname = usePathname();

  return (
    <ul className="-mb-px flex min-w-0 items-stretch gap-1 overflow-x-auto">
      {items.map(({ label, href }) => {
        const active = isUnder(pathname, href);
        return (
          <li key={href} className="flex">
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center border-b-2 px-3 text-sm whitespace-nowrap transition-colors",
                active
                  ? "bg-primary font-medium text-foreground"
                  : "border-transparent text-foreground/75 hover:text-foreground",
              )}
            >
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
