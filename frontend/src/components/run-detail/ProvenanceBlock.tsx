import type { RunProvenanceManifest } from "@/lib/run-detail-format";

function ProvenanceSection({ runId, manifest }: Readonly<{
  runId: string;
  manifest: RunProvenanceManifest;
}>): React.JSX.Element {
  return (
    <section aria-labelledby="run-provenance-heading" className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <h2 id="run-provenance-heading" className="text-sm font-semibold">Executed with</h2>
        <a
          className="text-xs text-primary underline underline-offset-2 hover:no-underline"
          href={`/api/v2/runs/${encodeURIComponent(runId)}/provenance/download`}
          download
        >
          Download manifest
        </a>
      </div>
      <dl className="grid gap-3 px-5 py-4 text-xs">
        <div><dt className="text-muted-foreground">Engine</dt><dd className="mt-0.5 font-medium">{manifest.engine.binary}{manifest.engine.version === null ? "" : ` ${manifest.engine.version}`}</dd></div>
        <div><dt className="text-muted-foreground">Configuration</dt><dd className="mt-0.5 break-all font-mono">{manifest.configuration.digest.slice(0, 16)}…</dd></div>
        <div><dt className="text-muted-foreground">Input state</dt><dd className="mt-0.5">{manifest.inputState.id ?? "None recorded"}</dd></div>
        <div><dt className="text-muted-foreground">Variables</dt><dd className="mt-0.5">{manifest.variables.length} sources captured; sensitive values redacted</dd></div>
        <div><dt className="text-muted-foreground">Sandbox</dt><dd className="mt-0.5">{manifest.sandbox.required ? "Required" : "Disabled"} · {manifest.sandbox.networkPolicy} network</dd></div>
        {manifest.rerun !== undefined && (
          <div>
            <dt className="text-muted-foreground">Rerun inputs</dt>
            <dd className="mt-0.5">
              {manifest.rerun.mode === "original" ? "Original captured inputs" : "Current workspace settings"}
              {manifest.rerun.changedSinceSource.length === 0
                ? " · no recorded differences"
                : ` · changed: ${manifest.rerun.changedSinceSource.join(", ")}`}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

export function ProvenanceBlock({ runId, manifest, error }: Readonly<{
  runId: string;
  manifest: RunProvenanceManifest | null;
  error: string;
}>): React.JSX.Element | null {
  if (manifest === null && error === "") return null;
  return (
    <>
      {manifest !== null && (
        <ProvenanceSection runId={runId} manifest={manifest} />
      )}
      {error !== "" && (
        <p role="status" className="rounded-lg border border-border bg-card px-5 py-3 text-xs text-muted-foreground">Executed-with details unavailable: {error}</p>
      )}
    </>
  );
}
