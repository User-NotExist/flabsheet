"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { PasswordNotice } from "@/components/accounts/password-notice";
import { FormError } from "@/components/auth/form-error";
import { createDataColumnHelper, DataTable } from "@/components/data-table/data-table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createStaff,
  getSession,
  listStaff,
  MIN_PASSWORD_LENGTH,
  resetStaffPassword,
  type StaffCredential,
  type StaffMember,
  updateStaff,
} from "@/lib/api";
import { ROLE_LABELS } from "@/lib/navigation";
import { useApiError } from "@/lib/use-api-error";

type ActionKind = "edit" | "status" | "reset";
type StaffAction = { kind: ActionKind; staff: StaffMember };

const helper = createDataColumnHelper<StaffMember>();

const LOGIN_ID_PATTERN = String.raw`[A-Za-z0-9._\-]{1,64}`;

function StatusBadge({ active }: { active: boolean }) {
  const color = active
    ? "bg-success text-success-foreground"
    : "bg-muted text-muted-foreground";

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${color}`}>
      {active ? "Active" : "Deactivated"}
    </span>
  );
}

function RowActions({
  member,
  isSelf,
  isLastAdmin,
  busy,
  hasCredential,
  onAction,
}: {
  member: StaffMember;
  isSelf: boolean;
  isLastAdmin: boolean;
  busy: boolean;
  hasCredential: boolean;
  onAction: (kind: ActionKind, member: StaffMember) => void;
}) {
  // The backend refuses these too; hiding them explains why up front.
  const canReset = !isSelf;
  const canToggle = !isSelf && !isLastAdmin;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <Button
        size="sm"
        variant="link"
        className="px-0"
        disabled={busy}
        onClick={() => onAction("edit", member)}
      >
        Edit name
      </Button>

      {canReset && (
        <Button
          size="sm"
          variant="link"
          className="px-0"
          disabled={busy || hasCredential}
          onClick={() => onAction("reset", member)}
        >
          Reset password
        </Button>
      )}

      {canToggle && (
        <Button
          size="sm"
          variant="link"
          className={member.is_active ? "px-0 text-destructive" : "px-0"}
          disabled={busy}
          onClick={() => onAction("status", member)}
        >
          {member.is_active ? "Deactivate" : "Reactivate"}
        </Button>
      )}

      {isLastAdmin && (
        <span className="text-xs text-muted-foreground">
          Last active admin: cannot be deactivated
        </span>
      )}
      {isSelf && !isLastAdmin && (
        <span className="text-xs text-muted-foreground">Your account</span>
      )}
    </div>
  );
}

function actionTitle(action: StaffAction): string {
  if (action.kind === "edit") return "Edit name";
  if (action.kind === "reset") return "Reset password";

  const noun = action.staff.role === "admin" ? "admin" : "staff account";
  return action.staff.is_active ? `Deactivate ${noun}` : `Reactivate ${noun}`;
}

function actionMessage(action: StaffAction): string {
  if (action.kind === "reset") {
    return "A new password will be shown once. The current password and sessions will expire.";
  }
  return action.staff.is_active
    ? "They will be signed out and cannot sign in. Their problems stay."
    : "They will be able to sign in again.";
}

export function StaffManager() {
  const toMessage = useApiError();

  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [selfId, setSelfId] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [credential, setCredential] = useState<StaffCredential | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [choosePassword, setChoosePassword] = useState(false);

  const [action, setAction] = useState<StaffAction | null>(null);
  const [busy, setBusy] = useState(false);

  const generation = useRef(0);
  const createForm = useRef<HTMLFormElement>(null);

  // A cached route can return after logout. Drop secrets and ignore outstanding writes.
  useLayoutEffect(() => () => {
    generation.current++;
    setStaff(null);
    setCredential(null);
    setCreated(null);
    setChoosePassword(false);
    setAction(null);
    setQuery("");
    setError(null);
    setActionError(null);
    setBusy(false);
    createForm.current?.reset();
  }, []);

  useEffect(() => {
    let cancelled = false;

    Promise.all([listStaff(), getSession()])
      .then(([items, user]) => {
        if (cancelled) return;
        setStaff(items);
        setSelfId(user.id);
      })
      .catch((err) => {
        if (!cancelled) setError(toMessage(err));
      });

    return () => {
      cancelled = true;
    };
  }, [revision, toMessage]);

  function refresh() {
    setError(null);
    setRevision((value) => value + 1);
  }

  function closeDialog() {
    setAction(null);
    setActionError(null);
  }

  async function createAccount(data: FormData) {
    const loginId = String(data.get("login_id")).trim();
    const name = String(data.get("display_name")).trim();
    const password = choosePassword ? String(data.get("password")) : undefined;

    const result = await createStaff(loginId, name, password);
    return { result, generated: password === undefined };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    const data = new FormData(event.currentTarget);
    const id = generation.current;
    const isStale = () => id !== generation.current;

    setBusy(true);
    setActionError(null);
    setCreated(null);

    try {
      if (!action) {
        const { result, generated } = await createAccount(data);
        if (isStale()) return;

        // A chosen password is already known to the admin, so don't show it again.
        if (generated) {
          setCredential(result);
        } else {
          setCreated(`Created ${result.staff.login_id}. They must change the password at first login.`);
        }
        setQuery("");
        setChoosePassword(false);
        createForm.current?.reset();
      } else if (action.kind === "reset") {
        const result = await resetStaffPassword(action.staff.id);
        if (isStale()) return;
        setCredential(result);
      } else {
        const update = action.kind === "edit"
          ? { display_name: String(data.get("display_name")).trim() }
          : { is_active: !action.staff.is_active };
        await updateStaff(action.staff.id, update);
        if (isStale()) return;
      }

      setAction(null);
      refresh();
    } catch (err) {
      if (!isStale()) setActionError(toMessage(err));
    } finally {
      if (!isStale()) setBusy(false);
    }
  }

  const hasCredential = credential !== null;
  const activeAdmins = staff?.filter(
    (member) => member.role === "admin" && member.is_active,
  ).length ?? 0;

  const openAction = useCallback((kind: ActionKind, member: StaffMember) => {
    setActionError(null);
    setAction({ kind, staff: member });
  }, []);

  // Memoised: a new column list on every render would rebuild the table's row models
  const columns = useMemo(() => helper.columns([
    helper.accessor("login_id", {
      header: "Login ID",
      sortFn: "alphanumeric",
      enableGlobalFilter: true,
      meta: { cellClassName: "font-mono text-xs break-all" },
    }),

    helper.accessor("display_name", {
      header: "Display name",
      sortFn: "text",
      enableGlobalFilter: true,
      meta: { cellClassName: "font-medium break-words" },
    }),

    helper.accessor((member) => ROLE_LABELS[member.role], {
      id: "role",
      header: "Role",
      sortFn: "text",
    }),

    helper.accessor((member) => (member.is_active ? "Active" : "Deactivated"), {
      id: "status",
      header: "Status",
      sortFn: "text",
      cell: ({ row }) => <StatusBadge active={row.original.is_active} />,
    }),

    helper.display({
      id: "actions",
      header: "Actions",
      meta: { cellClassName: "py-2" },
      cell: ({ row: { original: member } }) => (
        <RowActions
          member={member}
          isSelf={member.id === selfId}
          isLastAdmin={member.role === "admin" && member.is_active && activeAdmins <= 1}
          busy={busy}
          hasCredential={hasCredential}
          onAction={openAction}
        />
      ),
    }),
  ]), [activeAdmins, busy, hasCredential, openAction, selfId]);

  return (
    <main className="min-h-[calc(100vh-3rem)] bg-muted/30 text-sm">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-7 sm:px-6">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Staff accounts</h1>
          <p className="mt-1 text-muted-foreground">
            Only admins see this page. Staff can manage problems and students but not other staff.
          </p>
        </header>

        {credential && (
          <PasswordNotice
            account={credential.staff}
            password={credential.password}
            who="They"
            onSaved={() => setCredential(null)}
          />
        )}

        {created && (
          <p role="status" className="rounded-xl border border-primary bg-card px-4 py-3">
            {created}
          </p>
        )}

        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,26.5%)]">
          {/* Staff list */}
          <section className="min-w-0">
            {error && (
              <div className="mb-3 flex items-center gap-2">
                <FormError message={error} />
                <Button variant="outline" onClick={refresh}>Retry</Button>
              </div>
            )}

            <DataTable
              label="Staff accounts"
              data={staff}
              columns={columns}
              getRowId={(member) => String(member.id)}
              search={{ label: "Search by name or login ID" }}
              query={query}
              onQueryChange={setQuery}
              count={(rows) => `${rows} account${rows === 1 ? "" : "s"}`}
              loadingText={error ? "Could not load staff accounts." : "Loading staff accounts…"}
              emptyText="No staff accounts yet."
              noMatchText="No staff accounts match your search."
            />

            <p className="mt-3 text-xs text-muted-foreground">
              A deactivated staff member cannot sign in; the problems they wrote stay.
              Admin accounts are created from the server command line, not here.
            </p>
          </section>

          {/* Create form */}
          <aside className="w-full max-w-xs">
            <form
              ref={createForm}
              method="post"
              onSubmit={submit}
              className="grid gap-3 rounded-xl border bg-card p-4"
            >
              <h2 className="font-semibold">Add staff account</h2>

              <Label htmlFor="create-staff-login">Login ID</Label>
              <Input
                id="create-staff-login"
                name="login_id"
                required
                autoComplete="off"
                maxLength={64}
                pattern={LOGIN_ID_PATTERN}
                aria-describedby="staff-login-rule"
                onBlur={(e) => { e.target.value = e.target.value.trim(); }}
              />
              <p id="staff-login-rule" className="text-xs text-muted-foreground">
                Letters, digits, dot, dash, underscore. Up to 64 characters.
              </p>

              <Label htmlFor="create-staff-name">Display name</Label>
              <Input
                id="create-staff-name"
                name="display_name"
                required
                maxLength={100}
                autoComplete="off"
              />

              <fieldset className="grid gap-2">
                <legend className="mb-1 font-medium">Password</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="password_mode"
                    className="accent-primary"
                    checked={!choosePassword}
                    onChange={() => setChoosePassword(false)}
                  />
                  Generate one and show it once
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="password_mode"
                    className="accent-primary"
                    checked={choosePassword}
                    onChange={() => setChoosePassword(true)}
                  />
                  Set it myself
                </label>
              </fieldset>

              {choosePassword && (
                <>
                  <Label htmlFor="create-staff-password">New password</Label>
                  <Input
                    id="create-staff-password"
                    name="password"
                    type="password"
                    required
                    autoComplete="new-password"
                    minLength={MIN_PASSWORD_LENGTH}
                    maxLength={1024}
                    aria-describedby="staff-password-rule"
                  />
                  <p id="staff-password-rule" className="text-xs text-muted-foreground">
                    At least {MIN_PASSWORD_LENGTH} characters.
                  </p>
                </>
              )}

              {!action && <FormError message={actionError} />}

              <Button type="submit" size="lg" disabled={busy || hasCredential}>
                {busy && !action ? "Creating…" : "Create staff account"}
              </Button>
              <p className="text-xs text-muted-foreground">
                The generated password appears in the same one-time panel used on the Students page.
              </p>
            </form>
          </aside>
        </div>
      </div>

      {/* Edit / reset / deactivate dialog */}
      <Dialog
        open={!!action}
        onOpenChange={(open) => {
          if (!open && !busy) closeDialog();
        }}
      >
        {action && (
          <DialogContent>
            <DialogTitle>{actionTitle(action)}</DialogTitle>
            <DialogDescription>
              {action.staff.login_id} · {action.staff.display_name}
            </DialogDescription>

            <form method="post" onSubmit={submit} className="grid gap-3">
              {action.kind === "edit" ? (
                <>
                  <Label htmlFor="edit-staff-name">Display name</Label>
                  <Input
                    id="edit-staff-name"
                    name="display_name"
                    autoComplete="off"
                    defaultValue={action.staff.display_name}
                    maxLength={100}
                    required
                  />
                </>
              ) : (
                <p>{actionMessage(action)}</p>
              )}

              <FormError message={actionError} />

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" disabled={busy} onClick={closeDialog}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Saving…" : action.kind === "edit" ? "Save name" : actionTitle(action)}
                </Button>
              </div>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </main>
  );
}
