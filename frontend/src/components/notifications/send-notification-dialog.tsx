"use client";

import { useEffect, useId, useLayoutEffect, useState, type FormEvent } from "react";

import { FormError } from "@/components/auth/form-error";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_NOTIFICATION_BODY,
  MAX_NOTIFICATION_LINK,
  MAX_NOTIFICATION_TITLE,
  listStudents,
  sendNotification,
  type Student,
} from "@/lib/api";
import { notifyError, notifySuccess } from "@/lib/notify";
import { useApiError } from "@/lib/use-api-error";

/** The backend's rule: a path on this site, never "//host" or a backslash. */
function isSitePath(link: string): boolean {
  return /^\/([^/\s\\][^\s\\]*)?$/.test(link);
}

/**
 * Staff: send a "manual" notification to one active student or to all of
 * them. Opened by its own button:
 *
 *   <SendNotificationButton />
 */
export function SendNotificationButton({
  variant = "outline",
}: {
  variant?: "outline" | "default";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        Send notification
      </Button>
      {open && <SendNotificationDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function SendNotificationDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const toMessage = useApiError();
  const [students, setStudents] = useState<Student[] | null>(null);
  const [everyone, setEveryone] = useState(false);
  const [studentId, setStudentId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useLayoutEffect(() => () => setError(null), []);

  useEffect(() => {
    let cancelled = false;
    listStudents()
      .then((all) => {
        if (!cancelled) setStudents(all.filter((student) => student.is_active));
      })
      .catch((err) => {
        if (!cancelled) setError(toMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [toMessage]);

  const items = (students ?? []).map((student) => ({
    value: String(student.id),
    label: `${student.display_name} (${student.login_id})`,
  }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const path = link.trim();
    if (!everyone && !studentId) {
      setError("Choose a student, or send to every student.");
      return;
    }
    if (!title.trim()) {
      setError("Write a title.");
      return;
    }
    if (path && !isSitePath(path)) {
      setError("The link must be a path on this site, such as /problems/two-sum.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const sent = await sendNotification({
        ...(everyone ? { all: true } : { user_id: Number(studentId) }),
        title: title.trim(),
        body: body.trim() || undefined,
        link: path || undefined,
      });
      notifySuccess(`Sent to ${sent} ${sent === 1 ? "student" : "students"}.`);
      onClose();
    } catch (err) {
      notifyError(toMessage(err));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send a notification</DialogTitle>
          <DialogDescription>
            It appears under the bell of each student it is sent to, for 90 days.
          </DialogDescription>
        </DialogHeader>
        <form id={`${id}-form`} onSubmit={submit} className="grid gap-3 text-sm">
          <fieldset className="grid gap-1">
            <legend className="mb-1 font-medium">To</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={`${id}-target`}
                className="accent-primary"
                checked={!everyone}
                onChange={() => setEveryone(false)}
              />
              One student
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={`${id}-target`}
                className="accent-primary"
                checked={everyone}
                onChange={() => setEveryone(true)}
              />
              Every active student{students ? ` (${students.length})` : ""}
            </label>
          </fieldset>

          {!everyone && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-student`}>Student</Label>
              <Select
                items={items}
                value={studentId || null}
                onValueChange={(value) => setStudentId(value ?? "")}
              >
                <SelectTrigger id={`${id}-student`} className="w-full" disabled={!students}>
                  <SelectValue placeholder={students ? "Choose a student" : "Loading students…"} />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-title`}>Title</Label>
            <Input
              id={`${id}-title`}
              required
              autoComplete="off"
              maxLength={MAX_NOTIFICATION_TITLE}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-body`}>Message (optional)</Label>
            <Textarea
              id={`${id}-body`}
              rows={3}
              maxLength={MAX_NOTIFICATION_BODY}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-link`}>Link (optional)</Label>
            <Input
              id={`${id}-link`}
              autoComplete="off"
              placeholder="/problems/two-sum"
              maxLength={MAX_NOTIFICATION_LINK}
              value={link}
              onChange={(event) => setLink(event.target.value)}
            />
          </div>
          <FormError message={error} />
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={pending}>
            {pending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
