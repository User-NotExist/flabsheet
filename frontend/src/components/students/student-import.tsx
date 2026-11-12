"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ApiError, importStudents } from "@/lib/api";
import { useApiError } from "@/lib/use-api-error";

export function StudentImport({ onImported }: { onImported: () => void }) {
  const toMessage = useApiError();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [download, setDownload] = useState<Blob | null>(null);
  const [saved, setSaved] = useState(false);
  const request = useRef(0);

  useLayoutEffect(() => () => {
    request.current++;
    setDownload(null);
    setFile(null);
    setError(null);
    setPending(false);
    setSaved(false);
    setPreview("");
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (file) {
      file.slice(0, 800).text().then((text) => {
        if (!cancelled) setPreview(text.split(/\r?\n/).slice(0, 4).join("\n"));
      }).catch(() => {
        if (!cancelled) setError("Could not read the file. Choose it again.");
      });
    }
    return () => { cancelled = true; };
  }, [file]);

  function selectFile(selected?: File) {
    if (!selected || pending || download) return;
    setFile(selected);
    setPreview("");
    setError(null);
    setSaved(false);
  }

  async function submit() {
    if (!file || pending) return;
    const id = ++request.current;
    setPending(true);
    setError(null);
    try {
      const csv = await importStudents(file);
      if (id !== request.current) return;
      setDownload(csv);
      setFile(null);
      onImported();
    } catch (err) {
      if (id === request.current) {
        setError(err instanceof ApiError && err.code === "csv_invalid"
          ? `Nothing was imported. Correct the file and upload it again.\n${err.message}`
          : toMessage(err));
      }
    } finally {
      if (id === request.current) setPending(false);
    }
  }

  function savePasswords() {
    if (!download) return;
    const url = URL.createObjectURL(download);
    const link = document.createElement("a");
    link.href = url;
    link.download = "student-passwords.csv";
    link.click();
    // Give the browser time to open the blob before discarding the one-time download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownload(null);
    setSaved(true);
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <h2 className="font-semibold">Import from CSV</h2>
      <p className="text-muted-foreground">UTF-8 file with this header row:</p>
      <code className="rounded-md bg-muted px-3 py-2 text-xs">display_name,student_id</code>
      <Label
        htmlFor="student-csv"
        className="relative flex min-h-20 cursor-pointer justify-center rounded-lg border border-dashed border-muted-foreground px-3 text-center focus-within:ring-2 focus-within:ring-ring"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          selectFile(event.dataTransfer.files[0]);
        }}
      >
        {file ? <span className="break-all">{file.name}</span> : "Choose a CSV file or drop it here"}
        <input id="student-csv" type="file" accept=".csv,text/csv" className="sr-only"
          disabled={pending || !!download}
          onChange={(event) => {
            selectFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </Label>
      {file && (
        <>
          {preview && <pre aria-label="File preview" className="max-h-24 overflow-auto rounded-md bg-muted p-2 text-xs">{preview}</pre>}
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? "Importing…" : "Import students"}
          </Button>
        </>
      )}
      {error && <div className="max-h-52 overflow-auto rounded-md bg-destructive/10 p-3 wrap-anywhere whitespace-pre-line"><FormError message={error} /></div>}
      {download && (
        <>
          <p role="status">Students imported. Download their passwords before leaving this page.</p>
          <Button onClick={savePasswords}>Download passwords CSV</Button>
        </>
      )}
      {saved && <p role="status" className="text-success-foreground">Password CSV download started.</p>}
    </section>
  );
}
