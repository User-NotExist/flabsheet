"use client";

import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useRef, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import type { TestRow } from "@/components/problems/editor-form";
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
  MAX_HINT_LENGTH,
  MAX_TEST_CASES,
  MAX_TEST_INPUT_BYTES,
  type TestCase,
  type TestCaseVisibility,
  type TestData,
} from "@/lib/api";

const VISIBILITY_LABELS: Record<TestCaseVisibility, string> = {
  sample: "Sample: on problem page",
  visible: "Visible: in results",
  hidden: "Hidden: verdict only",
};

type Props = {
  tests: TestRow[];
  /** Takes a function of the current list, because uploads finish later. */
  onChange: (update: (tests: TestRow[]) => TestRow[]) => void;
  /**
   * Test cases of the newest version once its build is ok, else null. A row
   * shows the expected output and reference time of the built case at the
   * same position when it still has the same input.
   */
  built: TestCase[] | null;
  /** Stores one input. Rejects with the message to show. */
  uploadInput: (data: Blob) => Promise<TestData>;
  disabled?: boolean;
};

function Preview({ text, truncated }: { text: string; truncated: boolean }) {
  if (text === "") return <span className="text-muted-foreground">(empty)</span>;
  return (
    <span className="block max-w-56 truncate font-mono text-xs" title={text}>
      {text.trimEnd().replace(/\n/g, " ↵ ")}
      {truncated && "…"}
    </span>
  );
}

/** Ordered test cases: add by typing or uploading, reorder, remove (FR-PRB-09 to 11). */
export function TestCaseEditor({ tests, onChange, built, uploadInput, disabled }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [typed, setTyped] = useState("");

  const full = tests.length >= MAX_TEST_CASES;

  async function addInputs(inputs: Blob[]): Promise<boolean> {
    setError(null);
    if (tests.length + inputs.length > MAX_TEST_CASES) {
      setError(`A problem can have at most ${MAX_TEST_CASES} tests.`);
      return false;
    }
    if (inputs.some((input) => input.size > MAX_TEST_INPUT_BYTES)) {
      setError("A test input can be at most 8 MB.");
      return false;
    }
    setBusy(true);
    try {
      for (const input of inputs) {
        const stored = await uploadInput(input);
        const row: TestRow = {
          key: crypto.randomUUID(),
          input_sha256: stored.sha256,
          input_preview: stored.preview,
          input_truncated: stored.truncated,
          visibility: "hidden", // FR-PRB-10: hidden unless staff choose otherwise
          hint: "",
        };
        onChange((current) => [...current, row]);
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "The input could not be uploaded.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function update(index: number, patch: Partial<TestRow>) {
    onChange((current) =>
      current.map((test, i) => (i === index ? { ...test, ...patch } : test)),
    );
  }

  function move(index: number, by: -1 | 1) {
    onChange((current) => {
      const next = [...current];
      [next[index], next[index + by]] = [next[index + by], next[index]];
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Tests run in this order and count equally. Up to {MAX_TEST_CASES}{" "}
          tests, 8 MB per input.
        </p>
        <div className="flex gap-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".in,.txt,text/plain"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              // 1.in, 2.in, 10.in in numeric order, as the judge will run them
              const files = Array.from(event.target.files ?? []).sort((a, b) =>
                a.name.localeCompare(b.name, undefined, { numeric: true }),
              );
              event.target.value = "";
              if (files.length > 0) addInputs(files);
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={disabled || busy || full}
            onClick={() => fileInput.current?.click()}
          >
            {busy ? "Uploading…" : "Upload .in files"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={disabled || busy || full}
            onClick={() => setDialogOpen(true)}
          >
            Add test
          </Button>
        </div>
      </div>

      <FormError message={error} />

      {tests.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No tests yet. Type an input with “Add test” or upload .in files.
        </p>
      ) : (
        // relative: the sr-only header label is absolutely positioned, and
        // without a positioned scroller it widens the whole page on phones
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="w-8 py-2 pr-2 font-medium">#</th>
                <th className="px-2 py-2 font-medium">Input</th>
                <th className="px-2 py-2 font-medium">Expected output (from build)</th>
                <th className="px-2 py-2 font-medium">Students see</th>
                <th className="px-2 py-2 font-medium">Hint on failure (optional)</th>
                <th className="px-2 py-2 text-right font-medium">Ref. time</th>
                <th className="py-2 pl-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tests.map((test, index) => {
                const number = index + 1;
                const match = built?.[index];
                const result = match?.input_sha256 === test.input_sha256 ? match : null;
                return (
                  <tr key={test.key} className="border-b last:border-b-0">
                    <td className="py-2 pr-2 font-medium tabular-nums">{number}</td>
                    <td className="px-2 py-2">
                      <Preview text={test.input_preview} truncated={test.input_truncated} />
                    </td>
                    <td className="px-2 py-2">
                      {result?.answer_preview != null ? (
                        <Preview text={result.answer_preview} truncated={result.answer_truncated} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <Select
                        items={VISIBILITY_LABELS}
                        value={test.visibility}
                        disabled={disabled}
                        onValueChange={(visibility) => {
                          if (visibility) update(index, { visibility });
                        }}
                      >
                        <SelectTrigger
                          aria-label={`What students see of test ${number}`}
                          className="w-full min-w-48"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(VISIBILITY_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-2 py-2">
                      <Input
                        aria-label={`Hint for test ${number}`}
                        value={test.hint}
                        placeholder="None"
                        maxLength={MAX_HINT_LENGTH}
                        disabled={disabled}
                        onChange={(event) => update(index, { hint: event.target.value })}
                        className="min-w-36"
                      />
                    </td>
                    <td className="px-2 py-2 text-right whitespace-nowrap tabular-nums">
                      {result?.ref_time_ms != null ? `${result.ref_time_ms} ms` : "—"}
                    </td>
                    <td className="py-2 pl-2">
                      <div className="flex justify-end gap-0.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Move test ${number} up`}
                          disabled={disabled || index === 0}
                          onClick={() => move(index, -1)}
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Move test ${number} down`}
                          disabled={disabled || index === tests.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          <ArrowDown />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove test ${number}`}
                          disabled={disabled}
                          onClick={() => onChange((current) => current.filter((row) => row.key !== test.key))}
                        >
                          <X />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        Adding, removing or reordering tests, or changing what students see,
        creates a new version and starts a build when you save. Editing a
        hint does not.
      </p>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add test</DialogTitle>
            <DialogDescription>
              Type the input exactly as the program reads it from standard
              input. The expected output comes from the reference solution.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="typed-input">Input</Label>
            <Textarea
              id="typed-input"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              spellCheck={false}
              className="max-h-80 min-h-40 font-mono text-sm"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={async () => {
                // Programs reading line by line expect the last line to end
                const input = typed === "" || typed.endsWith("\n") ? typed : `${typed}\n`;
                if (await addInputs([new Blob([input])])) {
                  setTyped("");
                  setDialogOpen(false);
                }
              }}
            >
              {busy ? "Adding…" : "Add test"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
