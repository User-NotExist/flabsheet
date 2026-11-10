"use client";

import { usePathname, useRouter } from "next/navigation";
import { useLayoutEffect, useState } from "react";

import { ApiError, logout } from "@/lib/api";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const pathname = usePathname();

  // The router keeps the app layout mounted (hidden) while on /login, so
  // without this a user who signs back in finds the button still
  // "Logging out…". The cleanup runs when the layout is hidden and on every
  // navigation between app pages.
  useLayoutEffect(() => {
    return () => {
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

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={pending}
      title={failed ? "Sign out failed. Try again." : undefined}
      className="text-foreground/75 transition-colors hover:text-foreground disabled:opacity-50 data-[failed=true]:text-destructive"
      data-failed={failed}
    >
      {pending ? "Logging out…" : failed ? "Log out (retry)" : "Log out"}
    </button>
  );
}
