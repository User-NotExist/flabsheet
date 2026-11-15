"use client";

import { ChevronDownIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLayoutEffect, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ApiError, logout, type User } from "@/lib/api";
import { ROLE_LABELS } from "@/lib/navigation";

/** The signed-in user in the top bar: opens a menu with Change password and Log out. */
export function AccountMenu({
  user,
}: {
  user: Pick<User, "display_name" | "login_id" | "role">;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  // The router keeps the app layout mounted (hidden) while on /login, so
  // without this a user who signs back in finds the menu still open on
  // "Logging out…". The cleanup runs when the layout is hidden and on every
  // navigation between app pages.
  useLayoutEffect(() => {
    return () => {
      setOpen(false);
      setPending(false);
      setFailed(false);
    };
  }, [pathname]);

  async function handleLogout() {
    setPending(true);
    setFailed(false);
    try {
      await logout();
    } catch (err) {
      // 401: the session is already gone, which is what we wanted
      if (!(err instanceof ApiError && err.status === 401)) {
        setFailed(true);
        setPending(false);
        return;
      }
    }
    router.replace("/login");
  }

  const role = ROLE_LABELS[user.role];

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        aria-label={`Account: ${user.display_name}, ${role}`}
        className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-foreground/75 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-muted data-popup-open:text-foreground"
      >
        {/* The name does not fit beside the nav links on a phone */}
        <UserIcon aria-hidden className="size-4 sm:hidden" />
        <span className="hidden sm:inline">
          {user.display_name} · {role}
        </span>
        <ChevronDownIcon aria-hidden className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <div className="px-1.5 py-1">
          <p className="truncate text-sm font-medium">{user.display_name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {user.login_id} · {role}
          </p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/change-password" />}>
          Change password
        </DropdownMenuItem>
        {/* Stays open while signing out, so a failure is visible here */}
        <DropdownMenuItem
          closeOnClick={false}
          disabled={pending}
          variant={failed ? "destructive" : "default"}
          onClick={handleLogout}
        >
          {pending ? "Logging out…" : failed ? "Log out failed. Try again." : "Log out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
