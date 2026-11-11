import { BuildBadge } from "@/components/problems/problem-badges";
import { Button } from "@/components/ui/button";
import type { ProblemVersion } from "@/lib/api";

/** Plain-language meaning of the judge's build reason codes. */
function describeReason(reason: string | null): string {
  if (!reason) return "The build failed.";
  if (reason === "reference_ce") return "The reference solution does not compile.";
  if (reason === "superseded") return "A newer version was saved before this build started.";
  if (reason === "answer_hash_mismatch" || reason === "answers_incomplete") {
    return "The expected outputs did not arrive intact. Rebuild to try again.";
  }
  if (reason === "answer_upload_failed" || reason === "missing_upload_url") {
    return "The judge could not store the expected outputs. Rebuild to try again.";
  }
  const verdict = /^reference_(\w+)$/.exec(reason)?.[1];
  if (verdict) {
    const names: Record<string, string> = {
      tle: "ran over the time limit",
      mle: "ran over the memory limit",
      re: "crashed (runtime error)",
      ole: "printed too much output",
    };
    return `The reference solution ${names[verdict] ?? `failed (${verdict.toUpperCase()})`}.`;
  }
  return `The judge could not build the package (${reason}).`;
}

type Props = {
  /** The newest version, or null before the first save with tests. */
  version: ProblemVersion | null;
  /** Number of the version students are judged against, if any. */
  currentVersion: number | null;
  onRebuild: () => void;
  rebuilding: boolean;
  disabled?: boolean;
};

/** Build state of the newest version: pending, ok, or failed with the reason (FR-PRB-13). */
export function BuildPanel({ version, currentVersion, onRebuild, rebuilding, disabled }: Props) {
  const build = version?.build ?? null;
  const referenceLimit =
    version?.languages.find((l) => l.language_id === version.reference_language)
      ?.time_limit_ms ?? version?.time_limit_ms;
  const slow =
    build?.status === "ok" &&
    build.max_ref_time_ms !== null &&
    referenceLimit !== undefined &&
    build.max_ref_time_ms * 2 > referenceLimit;

  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Build</h2>
        <BuildBadge status={build?.status ?? null} />
      </div>

      {version === null ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          The first build starts when you save a reference solution and at
          least one test case.
        </p>
      ) : (
        <>
          <dl className="flex flex-col gap-1.5 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Version</dt>
              <dd className="tabular-nums">{version.version}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Tests</dt>
              <dd className="tabular-nums">{version.test_cases.length}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Slowest reference run</dt>
              <dd className="tabular-nums">
                {build?.max_ref_time_ms != null ? `${build.max_ref_time_ms} ms` : "—"}
              </dd>
            </div>
          </dl>

          {build?.status === "pending" && (
            <p className="text-sm leading-relaxed text-muted-foreground" role="status">
              Waiting for the judge to run the reference solution on every
              test. This page updates by itself.
            </p>
          )}

          {build?.status === "failed" && (
            <div role="alert" className="flex flex-col gap-2 text-sm leading-relaxed">
              <p className="text-destructive">
                {describeReason(build.reason)}
                {build.failed_testcase && ` Failing test: ${build.failed_testcase}.`}
              </p>
              {build.log && (
                <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-2.5 font-mono text-xs whitespace-pre-wrap">
                  {build.log}
                </pre>
              )}
            </div>
          )}

          {slow && (
            <p role="status" className="rounded-lg bg-warning px-3 py-2 text-sm leading-relaxed text-warning-foreground">
              The reference solution uses over half the time limit (
              {build?.max_ref_time_ms} of {referenceLimit} ms). Correct
              submissions may time out.
            </p>
          )}

          {build?.status !== "ok" && currentVersion !== null && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              Students are still judged against version {currentVersion}, the
              last one that built.
            </p>
          )}

          <Button
            type="button"
            variant="outline"
            onClick={onRebuild}
            disabled={disabled || rebuilding || build?.status === "pending"}
          >
            {rebuilding ? "Starting…" : "Rebuild"}
          </Button>
        </>
      )}
    </section>
  );
}
