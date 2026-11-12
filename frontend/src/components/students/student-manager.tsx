"use client";

import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { StudentImport } from "@/components/students/student-import";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createStudent,
  listStudents,
  resetStudentPassword,
  type Student,
  type StudentCredential,
  updateStudent,
} from "@/lib/api";
import { useApiError } from "@/lib/use-api-error";

type StudentAction = { kind: "edit" | "status" | "reset"; student: Student };

function PasswordNotice({ credential, onSaved }: { credential: StudentCredential; onSaved: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const { student, password } = credential;

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
    <section aria-label="Generated password" className="flex flex-wrap items-center gap-3 rounded-xl border border-primary bg-card px-4 py-3">
      <div role="status" className="mr-auto">
        <h2 className="font-semibold">Password for {student.login_id} ({student.display_name})</h2>
        <p className="text-muted-foreground">This is the only time it is shown. The student must change it at first login.</p>
      </div>
      <code className="rounded-md bg-muted px-3 py-2 select-all">{password}</code>
      <Button variant="outline" onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
      <Button className="bg-foreground text-background hover:bg-foreground/85" onClick={onSaved}>I have saved it</Button>
      {copyError && <p role="status" className="w-full text-muted-foreground">Select the password and copy it manually.</p>}
    </section>
  );
}

export function StudentManager() {
  const toMessage = useApiError();
  const [students, setStudents] = useState<Student[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [credential, setCredential] = useState<StudentCredential | null>(null);
  const [action, setAction] = useState<StudentAction | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const createForm = useRef<HTMLFormElement>(null);

  // A cached route can return after logout. Drop secrets and ignore outstanding writes.
  useLayoutEffect(() => () => {
    generation.current++;
    setStudents(null);
    setCredential(null);
    setAction(null);
    setQuery("");
    setError(null);
    setActionError(null);
    setBusy(false);
    createForm.current?.reset();
  }, []);

  useEffect(() => {
    let cancelled = false;
    listStudents().then((items) => {
      if (!cancelled) setStudents(items);
    }).catch((err) => {
      if (!cancelled) setError(toMessage(err));
    });
    return () => { cancelled = true; };
  }, [revision, toMessage]);

  function refresh() {
    setError(null);
    setRevision((value) => value + 1);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const id = generation.current;
    setBusy(true);
    setActionError(null);
    try {
      if (!action) {
        const studentId = String(data.get("student_id")).trim();
        const name = String(data.get("display_name")).trim();
        const result = await createStudent(studentId, name);
        if (id !== generation.current) return;
        setCredential(result);
        setQuery("");
        createForm.current?.reset();
      } else if (action.kind === "reset") {
        const result = await resetStudentPassword(action.student.id);
        if (id !== generation.current) return;
        setCredential(result);
      } else {
        await updateStudent(action.student.id, action.kind === "edit"
          ? { display_name: String(data.get("display_name")).trim() }
          : { is_active: !action.student.is_active });
        if (id !== generation.current) return;
      }
      setAction(null);
      refresh();
    } catch (err) {
      if (id === generation.current) setActionError(toMessage(err));
    } finally {
      if (id === generation.current) setBusy(false);
    }
  }

  function openAction(kind: StudentAction["kind"], student: Student) {
    setActionError(null);
    setAction({ kind, student });
  }

  const term = query.trim().toLowerCase();
  const visible = students?.filter((s) => s.login_id.toLowerCase().includes(term) || s.display_name.toLowerCase().includes(term));
  const actionTitle = action?.kind === "edit" ? "Edit name" : action?.kind === "reset" ? "Reset password" : action?.student.is_active ? "Deactivate student" : "Reactivate student";

  return (
    <main className="min-h-[calc(100vh-3rem)] bg-muted/30 text-sm">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-7 sm:px-6">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Students</h1>
          <p className="mt-1 text-muted-foreground">The student ID is the login ID. Passwords are generated here and shown only once.</p>
        </header>
        {credential && <PasswordNotice credential={credential} onSaved={() => setCredential(null)} />}

        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,26.5%)]">
          <section className="min-w-0">
            <div className="mb-3 flex items-center gap-3">
              <Label htmlFor="student-search" className="sr-only">Search by name or student ID</Label>
              <Input id="student-search" type="search" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or student ID" className="h-10 bg-card" />
              <span role="status" className="shrink-0 text-muted-foreground">
                {visible && `${visible.length} student${visible.length === 1 ? "" : "s"}`}
              </span>
            </div>
            {error && <div className="mb-3 flex items-center gap-2"><FormError message={error} /><Button variant="outline" onClick={refresh}>Retry</Button></div>}
            <div className="overflow-x-auto rounded-xl border bg-card">
              <table aria-label="Students" className="w-full text-left">
                <thead className="border-b text-xs text-muted-foreground">
                  <tr>{["Student ID", "Display name", "Status", "Actions"].map((label) =>
                    <th key={label} scope="col" className="px-3 py-3 font-medium">{label}</th>)}</tr>
                </thead>
                <tbody>
                  {(!visible || visible.length === 0) && (
                    <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                      {!visible ? (error ? "Could not load students." : "Loading students…") : term ? "No students match your search." : "No students yet."}
                    </td></tr>
                  )}
                  {visible?.map((student) => (
                    <tr key={student.id} className="border-b last:border-b-0">
                      <td className="px-3 py-3 font-mono text-xs break-all">{student.login_id}</td>
                      <td className="px-3 py-3 font-medium break-words">{student.display_name}</td>
                      <td className="px-3 py-3"><span className={`rounded-full px-2 py-0.5 text-xs ${student.is_active ? "bg-success text-success-foreground" : "bg-muted text-muted-foreground"}`}>
                        {student.is_active ? "Active" : "Deactivated"}
                      </span></td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                          <Button size="sm" variant="link" className="px-0" disabled={busy} onClick={() => openAction("edit", student)}>Edit name</Button>
                          <Button size="sm" variant="link" className="px-0" disabled={busy || !!credential} onClick={() => openAction("reset", student)}>Reset password</Button>
                          <Button size="sm" variant="link" className={student.is_active ? "px-0 text-destructive" : "px-0"} disabled={busy} onClick={() => openAction("status", student)}>
                            {student.is_active ? "Deactivate" : "Reactivate"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Deactivated students cannot sign in and are left off the leaderboard. Their submissions are kept.</p>
          </section>

          <aside className="grid w-full max-w-xs grid-cols-1 gap-4">
            <form ref={createForm} method="post" onSubmit={submit} className="grid gap-3 rounded-xl border bg-card p-4">
              <h2 className="font-semibold">Add one student</h2>
              <Label htmlFor="create-student-id">Student ID</Label>
              <Input id="create-student-id" name="student_id" required autoComplete="off" aria-describedby="student-id-rule"
                onBlur={(e) => { e.target.value = e.target.value.trim(); }} maxLength={64} pattern={String.raw`[A-Za-z0-9._\-]{1,64}`} />
              <p id="student-id-rule" className="text-xs text-muted-foreground">Letters, digits, dot, dash, underscore. Up to 64 characters.</p>
              <Label htmlFor="create-student-name">Display name</Label>
              <Input id="create-student-name" name="display_name" required maxLength={100} autoComplete="off" />
              {!action && <FormError message={actionError} />}
              <Button type="submit" size="lg" disabled={busy || !!credential}>
                {busy && !action ? "Creating…" : "Create and show password"}
              </Button>
            </form>
            <StudentImport onImported={refresh} />
          </aside>
        </div>
      </div>
      <Dialog open={!!action} onOpenChange={(open) => {
        if (!open && !busy) { setAction(null); setActionError(null); }
      }}>
        {action && (
          <DialogContent>
            <DialogTitle>{actionTitle}</DialogTitle>
            <DialogDescription>{action.student.login_id} · {action.student.display_name}</DialogDescription>
            <form method="post" onSubmit={submit} className="grid gap-3">
              {action.kind === "edit" ? (<>
                <Label htmlFor="edit-student-name">Display name</Label>
                <Input id="edit-student-name" name="display_name" autoComplete="off" defaultValue={action.student.display_name} maxLength={100} required />
              </>) : <p>{action.kind === "reset"
                ? "A new password will be shown once. The current password and sessions will expire."
                : action.student.is_active ? "This student will be signed out. Their submissions will be kept." : "This student will be able to sign in again."}</p>}
              <FormError message={actionError} />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" disabled={busy} onClick={() => { setAction(null); setActionError(null); }}>Cancel</Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Saving…" : action.kind === "edit" ? "Save name" : actionTitle}
                </Button>
              </div>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </main>
  );
}
