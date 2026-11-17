"use client";

import { useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { useInstanceSettings } from "@/components/settings/instance-settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { setSubmissionsOpen, type InstanceSettings } from "@/lib/api";
import { notifySuccess } from "@/lib/notify";
import { useApiError } from "@/lib/use-api-error";

const MAX_MESSAGE_LENGTH = 500; // same limit as the backend

/** Admin page for instance-wide switches. Only the submission killswitch so far (FR-ADM-05). */
export function SettingsManager() {
  const { settings } = useInstanceSettings();

  return (
    <main className="text-sm">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-7 sm:px-6">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-muted-foreground">
            Course-wide controls. Only admins can change these.
          </p>
        </header>
        {settings ? (
          <KillswitchCard settings={settings} />
        ) : (
          <p className="text-muted-foreground">Loading…</p>
        )}
      </div>
    </main>
  );
}

function KillswitchCard({ settings }: { settings: InstanceSettings }) {
  const toMessage = useApiError();
  const { refresh } = useInstanceSettings();
  const open = settings.submissions_open;

  // Rendered only once the settings are known, so the initial value is final
  const [message, setMessage] = useState(settings.submissions_message ?? "");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(nextOpen: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await setSubmissionsOpen(nextOpen, message.trim());
      setMessage(saved.submissions_message ?? "");
      setConfirming(false);
      notifySuccess(
        nextOpen
          ? "Submissions are open."
          : open
            ? "Submissions are closed."
            : "Message updated.",
      );
      // Updates the banner and Submit buttons now instead of at the next poll
      refresh();
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const messageChanged = message.trim() !== (settings.submissions_message ?? "");

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-1">
            <CardTitle className="text-lg">Accept new submissions</CardTitle>
            <p
              className={`font-medium ${open ? "text-success-foreground" : "text-warning-foreground"}`}
            >
              {open ? "Open: students can submit" : "Closed: nobody can submit"}
            </p>
          </div>
          <Switch
            aria-label="Accept new submissions"
            checked={open}
            disabled={busy}
            onCheckedChange={(checked) => {
              setError(null);
              // Closing blocks everyone, so ask first; reopening is safe
              if (checked) void save(true);
              else setConfirming(true);
            }}
          />
        </div>
      </CardHeader>

      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="killswitch-message">
            Message shown to everyone while closed (optional)
          </Label>
          <Textarea
            id="killswitch-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder="e.g. Closed for maintenance until 15:00."
            disabled={busy}
          />
          <p className="text-xs text-muted-foreground">
            Used when you close submissions. Reopening clears it.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h2 className="font-medium">While closed</h2>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>Students and staff cannot submit</li>
              <li>The Submit button is disabled with this message</li>
              <li>A banner shows on every page</li>
            </ul>
          </div>
          <div>
            <h2 className="font-medium">Keeps working</h2>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>Submissions already queued are judged</li>
              <li>Problems, results and the leaderboard</li>
              <li>Problem builds and staff rejudges</li>
            </ul>
          </div>
        </div>

        <FormError message={confirming ? null : error} />

        {!open && messageChanged && (
          <div className="flex justify-end">
            <Button variant="outline" disabled={busy} onClick={() => save(false)}>
              {busy ? "Saving…" : "Update message"}
            </Button>
          </div>
        )}
      </CardContent>

      <Dialog
        open={confirming}
        onOpenChange={(next) => {
          if (!next && !busy) setConfirming(false);
        }}
      >
        <DialogContent>
          <DialogTitle>Close submissions?</DialogTitle>
          <DialogDescription>
            Everyone, including staff, is blocked from submitting until you reopen.
          </DialogDescription>
          <FormError message={error} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => save(false)}>
              {busy ? "Saving…" : "Close submissions"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
