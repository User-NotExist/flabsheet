"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import { ImagePlusIcon } from "lucide-react";

import { FormError } from "@/components/auth/form-error";
import { MarkdownView } from "@/components/problems/markdown-view";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "@/lib/api";
import { cn } from "@/lib/utils";

type Props = {
  id: string;
  value: string;
  /** Takes the new text, or a function of the current text (image inserts finish later). */
  onChange: (next: string | ((current: string) => string)) => void;
  /** Stores an image and resolves to the URL to link. Rejects with the message to show. */
  uploadImage: (file: File) => Promise<string>;
  /** Told when uploads start and when the last one ends, so the caller can hold off saving. */
  onUploadingChange?: (uploading: boolean) => void;
  disabled?: boolean;
};

// Makes every placeholder unique, even for two files with the same name
let placeholderCount = 0;

/**
 * Markdown source next to its live preview. Images come in through the
 * "Insert image" button, paste or drop (FR-PRB-06): each one puts a
 * `[Uploading name… #n]` placeholder at the cursor straight away, which turns
 * into `![name](url)` once the upload is stored, or disappears if it fails.
 *
 * ```tsx
 * <MarkdownEditor id="statement" value={text} onChange={setText}
 *   uploadImage={(file) => uploadImage(problemId, file)} onUploadingChange={setUploading} />
 * ```
 */
export function MarkdownEditor({
  id,
  value,
  onChange,
  uploadImage,
  onUploadingChange,
  disabled,
}: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = uploading > 0;
  useEffect(() => {
    onUploadingChange?.(busy);
  }, [busy, onUploadingChange]);

  async function addImages(files: File[]) {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    setError(null);

    const accepted: { file: File; alt: string; token: string }[] = [];
    for (const file of images) {
      if (!IMAGE_TYPES.includes(file.type)) {
        setError("Images must be PNG, JPEG, GIF or WebP.");
      } else if (file.size > MAX_IMAGE_BYTES) {
        setError("An image can be at most 5 MB.");
      } else {
        // Brackets would end the alt text or the placeholder early
        const name = file.name.replace(/[[\]]/g, "");
        placeholderCount += 1;
        accepted.push({
          file,
          alt: name.replace(/\.[^.]*$/, ""),
          token: `[Uploading ${name}… #${placeholderCount}]`,
        });
      }
    }
    if (accepted.length === 0) return;

    // Placeholders go in at once, so the images land where the cursor was
    // even if the user types on while they upload
    const cursor = textarea.current?.selectionStart;
    const block = accepted.map(({ token }) => `${token}\n`).join("");
    onChange((text) => {
      const position = Math.min(cursor ?? text.length, text.length);
      return `${text.slice(0, position)}${block}${text.slice(position)}`;
    });

    setUploading((count) => count + accepted.length);
    for (const { file, alt, token } of accepted) {
      try {
        const link = `![${alt}](${await uploadImage(file)})`;
        // A function replacement: "$" in the link must not act as a pattern.
        // If the user deleted the placeholder, keep the image at the end
        onChange((text) =>
          text.includes(token) ? text.replace(token, () => link) : `${text}\n${link}\n`,
        );
      } catch (err) {
        onChange((text) => text.replace(`${token}\n`, "").replace(token, ""));
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

  function handleDragOver(event: DragEvent<HTMLTextAreaElement>) {
    // Only files, not dragged text, which the textarea handles itself
    if (disabled || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDragActive(true);
  }

  function handleDrop(event: DragEvent<HTMLTextAreaElement>) {
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      event.preventDefault();
      addImages(files);
    }
  }

  function handlePick(event: ChangeEvent<HTMLInputElement>) {
    addImages(Array.from(event.target.files ?? []));
    // Lets the same file be picked again
    event.target.value = "";
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <div className="flex min-h-7 items-center justify-between gap-2">
            <Label htmlFor={id}>Statement (Markdown)</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => picker.current?.click()}
              disabled={disabled}
            >
              <ImagePlusIcon aria-hidden="true" />
              Insert image
            </Button>
            <input
              ref={picker}
              type="file"
              accept={IMAGE_TYPES.join(",")}
              multiple
              hidden
              onChange={handlePick}
              aria-label="Image files to insert"
            />
          </div>
          <div className="relative flex flex-1 flex-col">
            <Textarea
              id={id}
              ref={textarea}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              onPaste={handlePaste}
              onDragEnter={handleDragOver}
              onDragOver={handleDragOver}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              disabled={disabled}
              spellCheck
              // The user sizes the box with the corner handle. No flex-1: a flex
              // basis of 0 overrides the height the handle sets, so dragging did
              // nothing. Fixed field sizing so the box doesn't jump as text changes
              className={cn(
                "h-96 min-h-48 resize-y font-mono text-sm field-sizing-fixed",
                dragActive && "ring-2 ring-primary",
              )}
            />
            {dragActive && (
              // pointer-events-none: the drop must still reach the textarea
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-background/80 text-sm font-medium text-primary">
                Drop images to upload
              </div>
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <p className="flex min-h-7 items-center text-sm leading-none font-medium">Preview</p>
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
        {busy
          ? "Uploading image…"
          : "Use Insert image, or paste or drop an image into the text (PNG, JPEG, GIF or WebP, up to 5 MB). Math: $x^2$ inline, or between two lines of $$ for a block."}
      </p>
      <FormError message={error} />
    </div>
  );
}
