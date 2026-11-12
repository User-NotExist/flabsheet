import { cn } from "cn";

import { Badge } from "@/components/ui/badge";

type Tone = "success" | "info" | "warning" | "danger" | "neutral";

const TONES: Record<Tone, string> = {
  success: "bg-success text-success-foreground",
  info: "bg-info text-info-foreground",
  warning: "bg-warning text-warning-foreground",
  danger: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  neutral: "bg-muted text-muted-foreground",
};

type VerdictInfo = { label: string; meaning: string; tone: Tone };

// Every verdict the judge can send (judge-worker-go README), each with a
// plain-language meaning (NFR-UX-03)
const VERDICTS: Record<string, VerdictInfo> = {
  AC: { label: "Accepted", meaning: "Every test passed.", tone: "success" },
  PA: {
    label: "Partially accepted",
    meaning: "Some tests passed and some did not.",
    tone: "info",
  },
  WA: {
    label: "Wrong answer",
    meaning: "Your output does not match the expected output.",
    tone: "danger",
  },
  PE: {
    label: "Presentation error",
    meaning: "Your answer is right but spacing or line breaks differ.",
    tone: "warning",
  },
  TLE: {
    label: "Time limit exceeded",
    meaning: "Your program ran longer than the time limit.",
    tone: "warning",
  },
  MLE: {
    label: "Memory limit exceeded",
    meaning: "Your program used more memory than the limit.",
    tone: "warning",
  },
  OLE: {
    label: "Output limit exceeded",
    meaning: "Your program printed far more than expected.",
    tone: "warning",
  },
  RE: {
    label: "Runtime error",
    meaning: "Your program crashed or exited with an error.",
    tone: "danger",
  },
  CE: {
    label: "Compile error",
    meaning: "Your code did not compile.",
    tone: "neutral",
  },
  SE: {
    label: "System error",
    meaning: "The judge had a problem. Staff will retry this submission.",
    tone: "neutral",
  },
  JE: {
    label: "Under review",
    meaning: "Under review by staff. This result does not change your score.",
    tone: "neutral",
  },
};

const UNKNOWN: VerdictInfo = {
  label: "Unknown result",
  meaning: "The judge sent a result this page does not know yet.",
  tone: "neutral",
};

export function verdictInfo(verdict: string): VerdictInfo {
  return VERDICTS[verdict] ?? UNKNOWN;
}

/**
 * A verdict as its code, or as "CODE · Label" when `long` is set. The colour
 * never stands alone: the text is always there, and the tooltip explains it.
 */
export function VerdictBadge({
  verdict,
  long,
  className,
}: {
  verdict: string;
  long?: boolean;
  className?: string;
}) {
  const info = verdictInfo(verdict);
  return (
    <Badge
      variant="secondary"
      title={`${info.label}: ${info.meaning}`}
      className={cn(TONES[info.tone], "font-semibold", className)}
    >
      {long ? `${verdict} · ${info.label}` : verdict}
      {!long && <span className="sr-only">: {info.label}</span>}
    </Badge>
  );
}
