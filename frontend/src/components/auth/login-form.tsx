"use client";

import { useLayoutEffect, useState, type FormEvent } from "react";

import { AUTH_BUTTON_CLASS, AUTH_INPUT_CLASS, resetOnDetach } from "@/components/auth/auth-shell";
import { FormError } from "@/components/auth/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, login } from "@/lib/api";
import { safeNextPath } from "@/lib/redirect";

function loginErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "Something went wrong. Please try again.";
  if (error.status === 429) {
    const minutes = error.retryAfter ? Math.ceil(error.retryAfter / 60) : null;
    return minutes
      ? `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`
      : error.message;
  }
  // A malformed login id fails validation; don't treat it differently
  if (error.status === 422) return "Invalid login id or password";
  return error.message;
}

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The router keeps this page mounted (hidden) after navigating away, so
  // clear the submit state and typed passwords instead of restoring them.
  useLayoutEffect(() => {
    return () => {
      setPending(false);
      setError(null);
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setPending(true);
    try {
      const user = await login(
        String(form.get("login_id") ?? "").trim(),
        String(form.get("password") ?? ""),
      );
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.replace(
        user.must_change_password ? "/change-password" : safeNextPath(next),
      );
    } catch (err) {
      setError(loginErrorMessage(err));
      setPending(false);
    }
  }

  return (
    <form
      method="post"
      ref={resetOnDetach}
      onSubmit={handleSubmit}
      className="flex flex-col gap-5"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="login_id">Login ID</Label>
        <Input
          id="login_id"
          name="login_id"
          placeholder="Student ID or staff login"
          className={AUTH_INPUT_CLASS}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={64}
          required
          autoFocus
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          className={AUTH_INPUT_CLASS}
          required
        />
      </div>
      <FormError message={error} />
      <Button type="submit" size="lg" className={AUTH_BUTTON_CLASS} disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
        Forgot your password? Ask course staff to reset it.
      </p>
    </form>
  );
}
