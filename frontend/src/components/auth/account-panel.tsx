"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { Button, buttonVariants } from "@/components/ui/button";
import { ApiError, getSession, logout, type User } from "@/lib/api";

export function AccountPanel() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The router keeps this page mounted (hidden) after navigating away, so
  // clear the sign-out state and the user, who may differ on return.
  useLayoutEffect(() => {
    return () => {
      setPending(false);
      setError(null);
      setUser(null);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((u) => {
        if (!cancelled) setUser(u);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login");
        } else if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Something went wrong.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleLogout() {
    setError(null);
    setPending(true);
    try {
      await logout();
    } catch (err) {
      // 401: the session is already gone, which is what we wanted
      if (!(err instanceof ApiError && err.status === 401)) {
        setError(err instanceof ApiError ? err.message : "Something went wrong.");
        setPending(false);
        return;
      }
    }
    router.replace("/login");
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {user ? (
          <>
            Signed in as{" "}
            <span className="font-medium text-foreground">{user.display_name}</span>{" "}
            ({user.login_id}, {user.role})
          </>
        ) : (
          "Loading…"
        )}
      </p>
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Link href="/change-password" className={buttonVariants({ variant: "outline" })}>
          Change password
        </Link>
        <Button variant="ghost" onClick={handleLogout} disabled={pending}>
          {pending ? "Signing out…" : "Sign out"}
        </Button>
      </div>
    </div>
  );
}
