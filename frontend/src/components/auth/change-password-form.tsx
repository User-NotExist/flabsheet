"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";

import {
  AUTH_BUTTON_CLASS,
  AUTH_INPUT_CLASS,
  AuthShell,
  resetOnDetach,
} from "@/components/auth/auth-shell";
import { FormError } from "@/components/auth/form-error";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ApiError,
  MIN_PASSWORD_LENGTH,
  changePassword,
  getSession,
} from "@/lib/api";

export function ChangePasswordForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // True when the account was flagged to change its password before going on
  const [forced, setForced] = useState(false);
  const [loginId, setLoginId] = useState<string | null>(null);

  // The router keeps this page mounted (hidden) after navigating away, so
  // clear the submit state and typed passwords instead of restoring them.
  useLayoutEffect(() => {
    return () => {
      setPending(false);
      setError(null);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((user) => {
        if (cancelled) return;
        setForced(user.must_change_password);
        setLoginId(user.login_id);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login?next=/change-password");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const current = String(form.get("current_password") ?? "");
    const next = String(form.get("new_password") ?? "");
    const confirm = String(form.get("confirm_password") ?? "");

    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    if (next === current) {
      setError("New password must differ from the current password.");
      return;
    }

    setError(null);
    setPending(true);
    try {
      await changePassword(current, next);
      window.location.replace("/");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/login?next=/change-password");
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : "Something went wrong. Please try again.",
      );
      setPending(false);
    }
  }

  return (
    <AuthShell
      title="Set a new password"
      description={
        // Non-breaking space keeps the line's height while the session loads
        loginId ? `Signed in as ${loginId}` : "\u00a0"
      }
    >
      <form
        method="post"
        ref={resetOnDetach}
        onSubmit={handleSubmit}
        className="flex flex-col gap-5"
      >
        {forced && (
          <p
            role="status"
            className="rounded-lg bg-warning px-3.5 py-2.5 text-sm leading-relaxed text-warning-foreground"
          >
            Your password was issued by staff. Choose your own before you
            continue.
          </p>
        )}
        <div className="flex flex-col gap-2">
          <Label htmlFor="current_password">Current password</Label>
          <Input
            id="current_password"
            name="current_password"
            type="password"
            autoComplete="current-password"
            className={AUTH_INPUT_CLASS}
            required
            autoFocus
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="new_password">New password</Label>
          <Input
            id="new_password"
            name="new_password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            className={AUTH_INPUT_CLASS}
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirm_password">Repeat new password</Label>
          <Input
            id="confirm_password"
            name="confirm_password"
            type="password"
            autoComplete="new-password"
            className={AUTH_INPUT_CLASS}
            required
          />
        </div>
        <FormError message={error} />
        <div className="flex flex-col gap-2">
          <Button
            type="submit"
            size="lg"
            className={AUTH_BUTTON_CLASS}
            disabled={pending}
          >
            {pending ? "Saving…" : "Save password"}
          </Button>
          {loginId && !forced && (
            <Link
              href="/"
              className={buttonVariants({
                variant: "ghost",
                size: "lg",
                className: AUTH_BUTTON_CLASS,
              })}
            >
              Cancel
            </Link>
          )}
        </div>
        <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
          Saving signs you out on every other device.
        </p>
      </form>
    </AuthShell>
  );
}
