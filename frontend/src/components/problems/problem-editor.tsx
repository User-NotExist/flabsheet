"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";

import { FormError } from "@/components/auth/form-error";
import { BuildPanel } from "@/components/problems/build-panel";
import { CodeEditor } from "@/components/problems/code-editor";
import {
  configFromForm,
  formFromDetail,
  hasBuildableConfig,
  validateFields,
  type EditorForm,
} from "@/components/problems/editor-form";
import { MarkdownEditor } from "@/components/problems/markdown-editor";
import { StatusBadge, enableBlockedReason } from "@/components/problems/problem-badges";
import { TestCaseEditor } from "@/components/problems/test-case-editor";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ApiError,
  deleteProblem,
  getBuildState,
  getProblem,
  listLanguages,
  rebuildProblem,
  setProblemState,
  updateProblem,
  uploadImage,
  uploadTestData,
  type Language,
  type ProblemDetail,
} from "@/lib/api";
import { useApiError } from "@/lib/use-api-error";

const BUILD_POLL_MS = 2000;

type Action = "save" | "rebuild" | "toggle" | "remove";

function EditorShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-4 sm:p-6">
      <Link
        href="/manage/problems"
        className="w-fit text-sm text-muted-foreground hover:text-foreground"
      >
        ← All problems
      </Link>
      {children}
    </main>
  );
}

/** Shown while the route's id is resolved and the problem loads. */
export function ProblemEditorFallback() {
  return (
    <EditorShell>
      <p role="status" className="text-sm text-muted-foreground">
        Loading problem…
      </p>
    </EditorShell>
  );
}

/**
 * The problem editor at /manage/problems/[id] (FR-PRB-04 to 17).
 *
 * `server` is the problem as last loaded or saved and `form` is what the user
 * is editing. Build results, the enable switch and other background updates
 * only replace `server`, so they never overwrite unsaved edits.
 */
export function ProblemEditor() {
  const router = useRouter();
  const toMessage = useApiError();
  const id = Number(useParams<{ id: string }>().id);

  const [server, setServer] = useState<ProblemDetail | null>(null);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [form, setForm] = useState<EditorForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // The router keeps this page mounted (hidden) after navigating away
  useLayoutEffect(() => {
    return () => {
      setAction(null);
      setError(null);
      setNotice(null);
      setConfirmOpen(false);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getProblem(id), listLanguages()])
      .then(([detail, registry]) => {
        if (cancelled) return;
        setServer(detail);
        setLanguages(registry);
        setForm(formFromDetail(detail, registry));
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiError && (err.status === 404 || err.status === 422)
            ? "This problem does not exist. It may have been deleted."
            : toMessage(err),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [id, toMessage]);

  // While a build is pending, watch the cheap build endpoint and reload the
  // problem (expected outputs, reference times) once it has finished.
  const pendingVersion =
    server?.version?.build.status === "pending" ? server.version.version : null;
  useEffect(() => {
    if (pendingVersion === null) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const state = await getBuildState(id);
        if (cancelled) return;
        if (state.build?.status === "pending" && state.version === pendingVersion) return;
        const detail = await getProblem(id);
        if (!cancelled) setServer(detail);
      } catch {
        // A missed poll is retried by the next tick
      }
    }, BUILD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, pendingVersion]);

  const baseline = useMemo(
    () => (server ? formFromDetail(server, languages) : null),
    [server, languages],
  );
  const dirty =
    form !== null && baseline !== null && JSON.stringify(form) !== JSON.stringify(baseline);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Uploads reject with a ready-to-show message
  const uploadImageFile = useCallback(
    async (file: File) => {
      try {
        return await uploadImage(id, file);
      } catch (err) {
        throw new Error(toMessage(err) ?? "Sign in again to continue.");
      }
    },
    [id, toMessage],
  );
  const uploadInput = useCallback(
    async (data: Blob) => {
      try {
        return await uploadTestData(id, data);
      } catch (err) {
        throw new Error(toMessage(err) ?? "Sign in again to continue.");
      }
    },
    [id, toMessage],
  );

  if (loadError) {
    return (
      <EditorShell>
        <FormError message={loadError} />
      </EditorShell>
    );
  }
  if (!server || !form) return <ProblemEditorFallback />;

  const readOnly = server.status === "archived";
  const busy = action !== null;
  const set = (patch: Partial<EditorForm>) => setForm({ ...form, ...patch });
  const allowed = languages.filter((language) => form.languages[language.id]?.allowed);
  const blocked = enableBlockedReason(
    server.status,
    server.can_enable,
    server.version?.build.status ?? null,
  );
  const canDelete = server.student_submission_count === 0;

  /** Runs one server action with the shared pending and error handling. */
  async function run(name: Action, work: () => Promise<void>) {
    setAction(name);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setAction(null);
    }
  }

  function save() {
    if (!form || !server) return;
    const current = form;
    const invalid = validateFields(current);
    if (invalid) {
      setError(invalid);
      return;
    }
    const buildable = hasBuildableConfig(current);
    const parsed = buildable ? configFromForm(current) : null;
    if (parsed && "error" in parsed) {
      setError(parsed.error);
      return;
    }
    const previousVersion = server.version?.version ?? 0;

    run("save", async () => {
      const detail = await updateProblem(id, {
        title: current.title.trim(),
        slug: current.slug,
        statement_md: current.statement,
        config: parsed?.config,
      });
      setServer(detail);
      if (parsed) {
        setForm(formFromDetail(detail, languages));
        setNotice(
          detail.version && detail.version.version > previousVersion
            ? `Saved. Version ${detail.version.version} is building.`
            : "Saved.",
        );
      } else {
        // Nothing versioned was sent, so keep what was typed in the other tabs
        setForm({
          ...current,
          title: detail.title,
          slug: detail.slug,
          statement: detail.statement_md,
        });
        setNotice(
          "Saved the title and statement. Settings, reference solution and tests are saved together once there is a reference solution and at least one test.",
        );
      }
    });
  }

  function remove() {
    run("remove", async () => {
      if (canDelete) {
        await deleteProblem(id);
        router.replace("/manage/problems");
      } else {
        setServer(await setProblemState(id, "archive"));
        setConfirmOpen(false);
      }
    });
  }

  return (
    <EditorShell>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-48 flex-[2] flex-col gap-2">
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            value={form.title}
            onChange={(event) => set({ title: event.target.value })}
            maxLength={200}
            autoComplete="off"
            disabled={readOnly}
            className="h-9 font-medium"
          />
        </div>
        <div className="flex min-w-40 flex-1 flex-col gap-2">
          <Label htmlFor="slug">URL slug</Label>
          <Input
            id="slug"
            value={form.slug}
            onChange={(event) => set({ slug: event.target.value })}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            disabled={readOnly}
            className="h-9 font-mono"
          />
        </div>
        <Button type="button" size="lg" onClick={save} disabled={readOnly || busy || !dirty}>
          {action === "save" ? "Saving…" : "Save"}
        </Button>
      </div>

      {readOnly && (
        <p role="status" className="rounded-lg bg-muted px-3.5 py-2.5 text-sm">
          This problem is archived. It is hidden from students and can no
          longer be changed.
        </p>
      )}
      <FormError message={error} />
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {dirty && !notice && !error && (
        <p className="text-sm text-muted-foreground">You have unsaved changes.</p>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Tabs defaultValue="statement" className="min-w-0 gap-0 rounded-xl border bg-card">
          {/* Full-width underline tabs; the indicator sits on the list's border */}
          <TabsList
            variant="line"
            className="w-full justify-start overflow-x-auto overflow-y-hidden border-b px-2 py-0 group-data-horizontal/tabs:h-10"
          >
            <TabsTrigger value="statement" className="h-full flex-none px-3 group-data-horizontal/tabs:after:bottom-0">Statement</TabsTrigger>
            <TabsTrigger value="settings" className="h-full flex-none px-3 group-data-horizontal/tabs:after:bottom-0">Settings</TabsTrigger>
            <TabsTrigger value="reference" className="h-full flex-none px-3 group-data-horizontal/tabs:after:bottom-0">Reference solution</TabsTrigger>
            <TabsTrigger value="tests" className="h-full flex-none px-3 group-data-horizontal/tabs:after:bottom-0">Test cases</TabsTrigger>
          </TabsList>

          <TabsContent value="statement" className="p-4 sm:p-5">
            <MarkdownEditor
              id="statement"
              value={form.statement}
              onChange={(next) =>
                setForm((f) =>
                  f
                    ? { ...f, statement: typeof next === "function" ? next(f.statement) : next }
                    : f,
                )
              }
              uploadImage={uploadImageFile}
              disabled={readOnly}
            />
          </TabsContent>

          <TabsContent value="settings" className="p-4 sm:p-5">
            <fieldset disabled={readOnly} className="flex max-w-2xl flex-col gap-6">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="max_points">Max points</Label>
                  <Input
                    id="max_points"
                    inputMode="numeric"
                    value={form.max_points}
                    onChange={(event) => set({ max_points: event.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="time_limit_ms">Time limit (ms)</Label>
                  <Input
                    id="time_limit_ms"
                    inputMode="numeric"
                    value={form.time_limit_ms}
                    onChange={(event) => set({ time_limit_ms: event.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="memory_limit_mb">Memory limit (MB)</Label>
                  <Input
                    id="memory_limit_mb"
                    inputMode="numeric"
                    value={form.memory_limit_mb}
                    onChange={(event) => set({ memory_limit_mb: event.target.value })}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2.5">
                <p className="text-sm font-medium">Allowed languages</p>
                {languages.map((language) => {
                  const choice = form.languages[language.id];
                  const change = (patch: Partial<typeof choice>) =>
                    set({
                      languages: { ...form.languages, [language.id]: { ...choice, ...patch } },
                    });
                  return (
                    <div key={language.id} className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <label className="flex min-w-44 items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={choice.allowed}
                          onChange={(event) => change({ allowed: event.target.checked })}
                          className="size-4 accent-primary"
                        />
                        {language.display}
                      </label>
                      <Input
                        aria-label={`Time limit for ${language.display} in ms`}
                        inputMode="numeric"
                        placeholder={`${form.time_limit_ms || "default"} ms`}
                        value={choice.time_limit_ms}
                        disabled={!choice.allowed}
                        onChange={(event) => change({ time_limit_ms: event.target.value })}
                        className="w-36"
                      />
                    </div>
                  );
                })}
                <p className="text-xs text-muted-foreground">
                  Leave a language&apos;s time limit empty to use the limit
                  above, or set its own (for example 3× for Python).
                </p>
              </div>

              <div className="flex flex-col gap-2.5">
                <p className="text-sm font-medium">Output checking</p>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="checker"
                    checked={form.checker_strict}
                    onChange={() => set({ checker_strict: true })}
                    className="mt-0.5 size-4 accent-primary"
                  />
                  <span>
                    Strict
                    <span className="block text-xs text-muted-foreground">
                      Values and whitespace layout must match, else the verdict
                      is a presentation error.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="checker"
                    checked={!form.checker_strict}
                    onChange={() => set({ checker_strict: false })}
                    className="mt-0.5 size-4 accent-primary"
                  />
                  <span>
                    Lenient
                    <span className="block text-xs text-muted-foreground">
                      Only the values are compared; spaces and line breaks are
                      ignored.
                    </span>
                  </span>
                </label>
                {form.checker_strict && (
                  <p className="rounded-lg bg-warning px-3 py-2 text-sm leading-relaxed text-warning-foreground">
                    In Strict mode the reference solution&apos;s exact output,
                    including trailing spaces, becomes the expected layout.
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-2.5">
                <p className="text-sm font-medium">Float tolerance (optional)</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="float_abs">Absolute</Label>
                    <Input
                      id="float_abs"
                      placeholder="None"
                      value={form.float_abs}
                      onChange={(event) => set({ float_abs: event.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="float_rel">Relative</Label>
                    <Input
                      id="float_rel"
                      placeholder="None"
                      value={form.float_rel}
                      onChange={(event) => set({ float_rel: event.target.value })}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  For example 1e-6. Leave both empty to compare numbers exactly.
                </p>
              </div>

              <p className="text-sm text-muted-foreground">
                Changing anything on this tab creates a new version and starts
                a build when you save.
              </p>
            </fieldset>
          </TabsContent>

          <TabsContent value="reference" className="p-4 sm:p-5">
            <div className="flex flex-col gap-4">
              <div className="flex max-w-xs flex-col gap-2">
                <Label htmlFor="reference_language">Language</Label>
                <Select
                  items={languages.map((l) => ({ value: l.id, label: l.display }))}
                  value={form.reference_language}
                  disabled={readOnly}
                  onValueChange={(reference_language) => {
                    if (reference_language) set({ reference_language });
                  }}
                >
                  <SelectTrigger id="reference_language" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Keep the saved choice selectable even after it was unticked */}
                    {languages
                      .filter((l) => allowed.includes(l) || l.id === form.reference_language)
                      .map((language) => (
                        <SelectItem key={language.id} value={language.id}>
                          {language.display}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <CodeEditor
                value={form.reference_source}
                onChange={(reference_source) => set({ reference_source })}
                languageId={form.reference_language}
                ariaLabel="Reference solution"
                readOnly={readOnly}
              />
              <p className="text-sm text-muted-foreground">
                The judge runs this solution on every test to produce the
                expected outputs. It must be in one of the allowed languages
                and at most 64 KB. Changing it creates a new version.
              </p>
            </div>
          </TabsContent>

          <TabsContent value="tests" className="p-4 sm:p-5">
            <TestCaseEditor
              tests={form.tests}
              onChange={(update) => setForm((f) => (f ? { ...f, tests: update(f.tests) } : f))}
              built={server.version?.build.status === "ok" ? server.version.test_cases : null}
              uploadInput={uploadInput}
              disabled={readOnly}
            />
          </TabsContent>
        </Tabs>

        <aside className="flex flex-col gap-5">
          <BuildPanel
            version={server.version}
            currentVersion={server.current_version}
            rebuilding={action === "rebuild"}
            disabled={readOnly || busy}
            onRebuild={() =>
              run("rebuild", async () => {
                setServer(await rebuildProblem(id));
              })
            }
          />

          <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold">Publishing</h2>
              <StatusBadge status={server.status} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="visible">Visible to students</Label>
              <Switch
                id="visible"
                checked={server.status === "enabled"}
                disabled={blocked !== null || busy}
                onCheckedChange={(checked) =>
                  run("toggle", async () => {
                    setServer(await setProblemState(id, checked ? "enable" : "disable"));
                  })
                }
              />
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {blocked
                ? `${blocked}. A problem can be shown to students once a build has succeeded.`
                : "Students are judged against the last version that built, also while a newer build is running or has failed."}
            </p>
            {server.current_version !== null && (
              <Link
                href={`/problems/${server.slug}`}
                className={buttonVariants({ variant: "outline" })}
              >
                Preview as student
              </Link>
            )}
          </section>

          {!readOnly && (
            <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
              <h2 className="text-base font-semibold">Maintenance</h2>
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={() => setConfirmOpen(true)}
              >
                {canDelete ? "Delete problem" : "Archive problem"}
              </Button>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {canDelete
                  ? "Delete is offered only while a problem has no student submissions."
                  : `Students have made ${server.student_submission_count} submission${server.student_submission_count === 1 ? "" : "s"}, so this problem can only be archived.`}
              </p>
            </section>
          )}
        </aside>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {canDelete ? "Delete this problem?" : "Archive this problem?"}
            </DialogTitle>
            <DialogDescription>
              {canDelete
                ? `“${server.title}”, its versions, test cases and your own test submissions will be deleted. This cannot be undone.`
                : `“${server.title}” will be hidden from students for good and can no longer be edited. Its submissions are kept. This cannot be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={remove}>
              {action === "remove"
                ? canDelete
                  ? "Deleting…"
                  : "Archiving…"
                : canDelete
                  ? "Delete problem"
                  : "Archive problem"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </EditorShell>
  );
}
