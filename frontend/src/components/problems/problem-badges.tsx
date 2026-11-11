import { Badge } from "@/components/ui/badge";
import type { BuildStatus, ProblemStatus } from "@/lib/api";

// The shadcn Badge has no success / info / warning variants, so these tones
// set the theme tokens on top of its "secondary" variant.
const TONES = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success text-success-foreground",
  info: "bg-info text-info-foreground",
  warning: "bg-warning text-warning-foreground",
};

function Tone({ tone, children }: { tone: keyof typeof TONES; children: string }) {
  return (
    <Badge variant="secondary" className={TONES[tone]}>
      {children}
    </Badge>
  );
}

const STATUS: Record<ProblemStatus, { label: string; tone: keyof typeof TONES }> = {
  enabled: { label: "Enabled", tone: "success" },
  disabled: { label: "Disabled", tone: "neutral" },
  draft: { label: "Draft", tone: "info" },
  archived: { label: "Archived", tone: "neutral" },
};

export function StatusBadge({ status }: { status: ProblemStatus }) {
  const { label, tone } = STATUS[status];
  return <Tone tone={tone}>{label}</Tone>;
}

/** `status` is null while the problem has no version to build yet. */
export function BuildBadge({ status }: { status: BuildStatus | null }) {
  if (status === null) return <Tone tone="neutral">Not built</Tone>;
  if (status === "ok") return <Tone tone="success">Build ok</Tone>;
  if (status === "failed") {
    return <Badge variant="destructive">Build failed</Badge>;
  }
  // The backend only knows "pending": the judge reports a build once, at the end
  return <Tone tone="warning">Building…</Tone>;
}

/** Why a problem cannot be shown to students yet, or null when it can. */
export function enableBlockedReason(
  status: ProblemStatus,
  canEnable: boolean,
  build: BuildStatus | null,
): string | null {
  if (status === "archived") return "Archived";
  if (canEnable) return null;
  if (build === "pending") return "Waiting for build";
  if (build === "failed") return "Fix the build first";
  return "Not built yet";
}
