"use client";

import { useEffect, useLayoutEffect, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { StaffHome } from "@/components/home/staff-home";
import { StudentHome } from "@/components/home/student-home";
import { Badge } from "@/components/ui/badge";
import { getSession, type User } from "@/lib/api";
import { ROLE_LABELS } from "@/lib/navigation";
import { useApiError } from "@/lib/use-api-error";

/** The signed-in home page at "/": a greeting, then the role's own overview. */
export function Dashboard() {
  const toMessage = useApiError();
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The router keeps this page mounted (hidden) after navigating away, and
  // the next viewer of "/" may be someone else after a sign-out
  useLayoutEffect(() => {
    return () => {
      setUser(null);
      setError(null);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((u) => {
        if (!cancelled) setUser(u);
      })
      .catch((err) => {
        if (!cancelled) setError(toMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [toMessage]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">
          {user ? `Welcome back, ${user.display_name}` : "Welcome back"}
        </h1>
        {user && <Badge variant="secondary">{ROLE_LABELS[user.role]}</Badge>}
      </div>

      <FormError message={error} />
      {!user && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading…
        </p>
      )}

      {user?.role === "student" && <StudentHome />}
      {user && user.role !== "student" && <StaffHome role={user.role} />}
    </main>
  );
}
