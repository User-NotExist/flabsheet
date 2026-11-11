"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useState, type FormEvent } from "react";

import { FormError } from "@/components/auth/form-error";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SLUG_PATTERN, createProblem } from "@/lib/api";
import { useApiError } from "@/lib/use-api-error";

/** "Sort three numbers!" → "sort-three-numbers" */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * First step of a new problem: the draft must exist before the editor can
 * attach images and test inputs to it, so only title and slug are asked here.
 */
export function NewProblemForm() {
  const router = useRouter();
  const toMessage = useApiError();
  const [title, setTitle] = useState("");
  // null = follow the title until the user types a slug of their own
  const [slug, setSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The router keeps this page mounted (hidden) after navigating away
  useLayoutEffect(() => {
    return () => {
      setPending(false);
      setError(null);
      setTitle("");
      setSlug(null);
    };
  }, []);

  const effectiveSlug = slug ?? slugify(title);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) {
      setError("Enter a title.");
      return;
    }
    if (!SLUG_PATTERN.test(effectiveSlug)) {
      setError("The URL slug may use lower-case letters, digits and hyphens, up to 64 characters.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const problem = await createProblem(title.trim(), effectiveSlug);
      router.replace(`/manage/problems/${problem.id}`);
    } catch (err) {
      setError(toMessage(err));
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-5 p-4 sm:p-6">
      <Link
        href="/manage/problems"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← All problems
      </Link>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">New problem</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The problem starts as a draft that students cannot see. You add the
          statement, reference solution and test cases next.
        </p>
      </div>
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-5 rounded-xl border bg-card p-4 sm:p-5"
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            autoComplete="off"
            required
            autoFocus
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="slug">URL slug</Label>
          <Input
            id="slug"
            value={effectiveSlug}
            onChange={(event) => setSlug(event.target.value)}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            required
          />
          <p className="text-xs text-muted-foreground">
            Students open the problem at /problems/{effectiveSlug || "…"}.
          </p>
        </div>
        <FormError message={error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="lg" disabled={pending}>
            {pending ? "Creating…" : "Create and continue"}
          </Button>
          <Link
            href="/manage/problems"
            className={buttonVariants({ variant: "ghost", size: "lg" })}
          >
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}
