"use client";

import { useId, useState, type FormEvent } from "react";

import { FormError } from "@/components/auth/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_CLARIFICATION_BODY,
  MAX_CLARIFICATION_TAG_LENGTH,
  MAX_CLARIFICATION_TAGS,
  MAX_CLARIFICATION_TITLE,
  type ClarificationKind,
  type ClarificationVisibility,
} from "@/lib/api";

export type ThreadValues = {
  title: string;
  body_md: string;
  tags: string[];
  kind: ClarificationKind;
  visibility: ClarificationVisibility;
};

const EMPTY: ThreadValues = {
  title: "",
  body_md: "",
  tags: [],
  kind: "question",
  visibility: "private",
};

/** "a, b , a" → ["a", "b"]: trimmed, without blanks or repeats. */
function parseTags(text: string): string[] {
  return [...new Set(text.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

function MarkdownHint({ id, length }: { id: string; length: number }) {
  return (
    <p id={id} className="text-xs text-muted-foreground">
      Markdown and $math$ work. Images only from this site.{" "}
      <span className="tabular-nums">
        {length} / {MAX_CLARIFICATION_BODY}
      </span>
    </p>
  );
}

/**
 * Title, body and tags of a thread: asking a question, posting an
 * announcement, or editing either. `onSubmit` resolves to true when the post
 * was saved, which empties a new-post form.
 */
export function ThreadForm({
  initial,
  allowKind = false,
  allowVisibility = false,
  submitLabel,
  pendingLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<ThreadValues>;
  /** Staff on a problem: question or announcement. */
  allowKind?: boolean;
  /** A new question: private (default) or public. */
  allowVisibility?: boolean;
  submitLabel: string;
  pendingLabel: string;
  onSubmit: (values: ThreadValues) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const id = useId();
  const start = { ...EMPTY, ...initial };
  const [title, setTitle] = useState(start.title);
  const [body, setBody] = useState(start.body_md);
  const [tagText, setTagText] = useState(start.tags.join(", "));
  const [kind, setKind] = useState<ClarificationKind>(start.kind);
  const [visibility, setVisibility] = useState<ClarificationVisibility>(start.visibility);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const tags = parseTags(tagText);
    if (!title.trim() || !body.trim()) {
      setError("Write a title and a message.");
      return;
    }
    if (tags.length > MAX_CLARIFICATION_TAGS) {
      setError(`Use at most ${MAX_CLARIFICATION_TAGS} tags.`);
      return;
    }
    if (tags.some((tag) => tag.length > MAX_CLARIFICATION_TAG_LENGTH)) {
      setError(`Keep each tag under ${MAX_CLARIFICATION_TAG_LENGTH + 1} characters.`);
      return;
    }
    setError(null);
    setPending(true);
    const saved = await onSubmit({ title: title.trim(), body_md: body, tags, kind, visibility });
    setPending(false);
    if (saved && !initial) {
      setTitle("");
      setBody("");
      setTagText("");
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      {allowKind && (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <legend className="mb-1 font-medium">Post as</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${id}-kind`}
              className="accent-primary"
              checked={kind === "question"}
              onChange={() => setKind("question")}
            />
            Question
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${id}-kind`}
              className="accent-primary"
              checked={kind === "announcement"}
              onChange={() => setKind("announcement")}
            />
            Announcement (public, notifies every student)
          </label>
        </fieldset>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-title`}>Title</Label>
        <Input
          id={`${id}-title`}
          required
          autoComplete="off"
          maxLength={MAX_CLARIFICATION_TITLE}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-body`}>Message</Label>
        <Textarea
          id={`${id}-body`}
          required
          rows={4}
          maxLength={MAX_CLARIFICATION_BODY}
          aria-describedby={`${id}-body-hint`}
          className="max-h-80"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <MarkdownHint id={`${id}-body-hint`} length={body.length} />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-tags`}>Tags (optional)</Label>
        <Input
          id={`${id}-tags`}
          autoComplete="off"
          placeholder="output, edge cases"
          aria-describedby={`${id}-tags-hint`}
          value={tagText}
          onChange={(event) => setTagText(event.target.value)}
        />
        <p id={`${id}-tags-hint`} className="text-xs text-muted-foreground">
          Separate with commas. Up to {MAX_CLARIFICATION_TAGS}.
        </p>
      </div>

      {allowVisibility && kind === "question" && (
        <fieldset className="grid gap-1 text-sm">
          <legend className="mb-1 font-medium">Who can see it</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${id}-visibility`}
              className="accent-primary"
              checked={visibility === "private"}
              onChange={() => setVisibility("private")}
            />
            Only me and staff
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${id}-visibility`}
              className="accent-primary"
              checked={visibility === "public"}
              onChange={() => setVisibility("public")}
            />
            Every student (don&apos;t post your code)
          </label>
        </fieldset>
      )}

      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** A reply, new or edited. Resolves to true when saved, which empties a new one. */
export function ReplyForm({
  initial,
  label = "Reply",
  submitLabel,
  pendingLabel,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  label?: string;
  submitLabel: string;
  pendingLabel: string;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const id = useId();
  const [body, setBody] = useState(initial ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!body.trim()) {
      setError("Write a message first.");
      return;
    }
    setError(null);
    setPending(true);
    const saved = await onSubmit(body);
    setPending(false);
    if (saved && initial === undefined) setBody("");
  }

  return (
    <form onSubmit={submit} className="grid gap-1.5">
      <Label htmlFor={`${id}-body`}>{label}</Label>
      <Textarea
        id={`${id}-body`}
        required
        rows={3}
        maxLength={MAX_CLARIFICATION_BODY}
        aria-describedby={`${id}-hint`}
        className="max-h-72"
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <MarkdownHint id={`${id}-hint`} length={body.length} />
      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
