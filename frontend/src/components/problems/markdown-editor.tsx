"use client";

import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";

import { FormError } from "@/components/auth/form-error";
import { MarkdownView } from "@/components/problems/markdown-view";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "@/lib/api";

type Props = {
  id: string;
  value: string;
  /** Takes the new text, or a function of the current text (image inserts finish later). */
  onChange: (next: string | ((current: string) => string)) => void;
  /** Stores an image and resolves to the URL to link. Rejects with the message to show. */
  uploadImage: (file: File) => Promise<string>;
  disabled?: boolean;
};

/**
 * Markdown source next to its live preview. Pasting or dropping an image
 * uploads it and inserts `![](url)` at the cursor (FR-PRB-06).
 */
export function MarkdownEditor({ id, value, onChange, uploadImage, disabled }: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function addImages(files: File[]) {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    setError(null);
    for (const file of images) {
      if (!IMAGE_TYPES.includes(file.type)) {
        setError("Images must be PNG, JPEG, GIF or WebP.");
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setError("An image can be at most 5 MB.");
        continue;
      }
      setUploading((count) => count + 1);
      try {
        const url = await uploadImage(file);
        const cursor = textarea.current?.selectionStart;
        const alt = file.name.replace(/\.[^.]*$/, "").replace(/[[\]]/g, "");
        // A function of the current text: the user may have typed on while
        // the upload ran
        onChange((text) => {
          const position = Math.min(cursor ?? text.length, text.length);
          return `${text.slice(0, position)}![${alt}](${url})\n${text.slice(position)}`;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "The image could not be uploaded.");
      } finally {
        setUploading((count) => count - 1);
      }
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    if (files.some((file) => file.type.startsWith("image/"))) {
      event.preventDefault();
      addImages(files);
    }
  }

  function handleDrop(event: DragEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      event.preventDefault();
      addImages(files);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={id}>Statement (Markdown)</Label>
          <Textarea
            id={id}
            ref={textarea}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onPaste={handlePaste}
            onDrop={handleDrop}
            disabled={disabled}
            spellCheck
            // field-sizing lets the box grow with the text; cap it so the preview stays in view
            className="max-h-[70vh] min-h-96 flex-1 font-mono text-sm"
          />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm leading-none font-medium">Preview</p>
          <div className="min-h-24 flex-1 overflow-x-auto rounded-lg border p-3">
            {value.trim() ? (
              <MarkdownView source={value} />
            ) : (
              <p className="text-sm text-muted-foreground">
                The statement appears here as students will see it.
              </p>
            )}
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {uploading > 0
          ? "Uploading image…"
          : "Paste or drop an image into the text to upload it (PNG, JPEG, GIF or WebP, up to 5 MB). Math: $x^2$ inline, or between two lines of $$ for a block."}
      </p>
      <FormError message={error} />
    </div>
  );
}
