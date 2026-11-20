"use client";

import { useId, useState } from "react";

import { ThreadForm } from "@/components/clarifications/post-forms";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createAnnouncement,
  createProblemClarification,
  type Clarification,
} from "@/lib/api";
import { notifyError, notifySuccess } from "@/lib/notify";
import { useApiError } from "@/lib/use-api-error";

const COURSE_WIDE = "__course";

/**
 * Staff: post an announcement, course-wide (shown on every dashboard) or on
 * one enabled problem (its Clarifications tab). Either way every active
 * student gets a notification.
 */
export function AnnouncementDialog({
  open,
  onOpenChange,
  problems,
  onPosted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Enabled problems: the ones students can open. */
  problems: readonly { slug: string; title: string }[];
  onPosted?: (thread: Clarification) => void;
}) {
  const id = useId();
  const toMessage = useApiError();
  const [target, setTarget] = useState(COURSE_WIDE);

  const items = [
    { value: COURSE_WIDE, label: "Course-wide (dashboard)" },
    ...problems.map((problem) => ({ value: problem.slug, label: problem.title })),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Post an announcement</DialogTitle>
          <DialogDescription>
            Every active student is notified. It is public and students cannot reply to it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5 text-sm">
          <Label htmlFor={`${id}-target`}>Where</Label>
          <Select
            items={items}
            value={target}
            onValueChange={(value) => {
              if (value) setTarget(value);
            }}
          >
            <SelectTrigger id={`${id}-target`} className="w-full">
              <SelectValue />
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
        <ThreadForm
          submitLabel="Post and notify"
          pendingLabel="Posting…"
          onCancel={() => onOpenChange(false)}
          onSubmit={async (values) => {
            const post = { title: values.title, body_md: values.body_md, tags: values.tags };
            try {
              const created =
                target === COURSE_WIDE
                  ? await createAnnouncement(post)
                  : await createProblemClarification(target, { ...post, kind: "announcement" });
              notifySuccess("Announcement posted. Students were notified.");
              onPosted?.(created);
              onOpenChange(false);
              return true;
            } catch (err) {
              notifyError(toMessage(err));
              return false;
            }
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
