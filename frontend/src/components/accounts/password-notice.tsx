"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

type Account = { login_id: string; display_name: string };

/** One-time panel for a new or reset password (student and staff pages). */
export function PasswordNotice({
  account,
  password,
  who,
  onSaved,
}: {
  account: Account;
  password: string;
  /** Who must change it, e.g. "The student". */
  who: string;
  onSaved: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <section
      aria-label="Generated password"
      className="flex flex-wrap items-center gap-3 rounded-xl border border-primary bg-card px-4 py-3"
    >
      <div role="status" className="mr-auto">
        <h2 className="font-semibold">
          Password for {account.login_id} ({account.display_name})
        </h2>
        <p className="text-muted-foreground">
          This is the only time it is shown. {who} must change it at first login.
        </p>
      </div>

      <code className="rounded-md bg-muted px-3 py-2 select-all">{password}</code>

      <Button variant="outline" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </Button>
      <Button
        className="bg-foreground text-background hover:bg-foreground/85"
        onClick={onSaved}
      >
        I have saved it
      </Button>

      {copyError && (
        <p role="status" className="w-full text-muted-foreground">
          Select the password and copy it manually.
        </p>
      )}
    </section>
  );
}
