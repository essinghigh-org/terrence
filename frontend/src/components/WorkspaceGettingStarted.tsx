import { useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, CircleAlert, Copy, LoaderCircle } from "lucide-react";
import { Button, buttonVariants } from "./ui/button";
import { toast } from "./ui/toast";
import { copyTextToClipboard } from "../lib/utils";
import { fetchApi } from "../lib/api";

type PreflightCheck = Readonly<{
  id?: unknown;
  status?: unknown;
  required?: unknown;
  advisory?: unknown;
  detail?: unknown;
  fix?: unknown;
}>;

type PreflightResponse = Readonly<{
  data?: Readonly<{
    attributes?: Readonly<{
      status?: unknown;
      "can-run-anyway"?: unknown;
      checks?: unknown;
    }>;
  }>;
}>;
type PreflightData = NonNullable<PreflightResponse["data"]>;

export function WorkspaceGettingStarted({
  workspaceId, orgName, workspaceName, engine, source, hasRepository, localExecution, canQueueRun, canUpdate, canReadVariable,
}: Readonly<{
  workspaceId?: string;
  orgName: string;
  workspaceName: string;
  engine: string;
  source?: string | undefined;
  hasRepository: boolean;
  localExecution: boolean;
  canQueueRun: boolean;
  canUpdate: boolean;
  canReadVariable: boolean;
}>): React.JSX.Element {
  const [preflight, setPreflight] = useState<PreflightData | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const workspacePath = `/app/${encodeURIComponent(orgName)}/workspaces/${encodeURIComponent(workspaceName)}`;
  const cli = engine === "tofu" ? "tofu" : "terraform";
  const hostname = window.location.host;
  const configuration = `terraform {\n  backend "remote" {\n    hostname     = ${JSON.stringify(hostname)}\n    organization = ${JSON.stringify(orgName)}\n    workspaces {\n      name = ${JSON.stringify(workspaceName)}\n    }\n  }\n}`;
  const usesServerCode = !localExecution && (hasRepository || source === "local");
  const readiness = [
    {
      label: localExecution ? "Local execution is configured" : hasRepository ? "Repository is connected" : "Configuration connection is still needed",
      ready: localExecution || hasRepository || source === "local",
    },
    {
      label: canReadVariable ? "Variable access is available" : "Variable access requires permission",
      ready: canReadVariable,
    },
    {
      label: canQueueRun ? "Plan permission is available" : "Plan permission requires an administrator",
      ready: canQueueRun,
    },
  ] as const;
  const readinessComplete = readiness.every((step): boolean => step.ready);

  const runPreflight = (): void => {
    setPreflightLoading(true);
    setPreflightError(null);
    void fetchApi<PreflightResponse>(`/workspaces/${encodeURIComponent(workspaceId ?? "")}/actions/preflight`, {
      method: "POST",
      body: JSON.stringify({ data: { type: "preflight-assessments", attributes: {} } }),
    }).then((response): void => {
      setPreflight(response.data ?? null);
    }).catch((error: unknown): void => {
      setPreflightError(error instanceof Error ? error.message : "Could not check run readiness.");
    }).finally((): void => {
      setPreflightLoading(false);
    });
  };

  const checks = Array.isArray(preflight?.attributes?.checks)
    ? (preflight.attributes.checks as PreflightCheck[])
    : [];
  const preflightStatus = typeof preflight?.attributes?.status === "string" ? preflight.attributes.status : "unknown";

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Ready for your first plan</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {localExecution ? "Connect your CLI to store state in Terrence while running plans on your computer."
            : hasRepository ? "Your repository is connected. Add any required variables, then preview the changes in your code."
            : source === "local" ? "Mount your configuration directory on the Terrence server, then add any variables your code needs."
            : "Connect your existing configuration to this workspace. Your CLI uploads the code; Terrence keeps the state and run history together."}
        </p>
      </div>
      <section aria-labelledby="workspace-readiness-heading" className="rounded-md border border-border bg-muted/20 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 id="workspace-readiness-heading" className="text-sm font-semibold">Workspace readiness</h4>
          <span className={readinessComplete ? "text-xs font-medium text-success" : "text-xs font-medium text-warning-text"}>
            {readinessComplete ? "Ready for a plan" : "Setup required"}
          </span>
        </div>
        <ul className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
          {readiness.map((step): React.JSX.Element => (
            <li key={step.label} className="flex items-start gap-1.5">
              {step.ready
                ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />
                : <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning-text" aria-hidden="true" />}
              <span>{step.label}</span>
            </li>
          ))}
        </ul>
      </section>
      {!usesServerCode && (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">1. Add this backend to your configuration</p>
              <Button size="icon-sm" variant="ghost" aria-label="Copy backend configuration" onClick={(): void => {
                void copyTextToClipboard(configuration).then((copied): void => {
                  toast.add({ title: copied ? "Backend configuration copied" : "Could not copy. Select and copy the configuration below.", type: copied ? "success" : "error" });
                });
              }}><Copy aria-hidden="true" /></Button>
            </div>
            <p className="text-xs text-muted-foreground">Use this in place of an existing backend or cloud block.</p>
            <pre className="overflow-x-auto rounded-md bg-muted/60 p-4 text-xs leading-relaxed"><code>{configuration}</code></pre>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">2. Sign in and run a plan from your code directory</p>
            <pre className="overflow-x-auto rounded-md bg-muted/60 p-4 text-xs leading-relaxed"><code>{`${cli} login ${hostname}\n${cli} init\n${cli} plan`}</code></pre>
            {window.location.protocol !== "https:" && <p className="text-sm text-muted-foreground">CLI login requires HTTPS. <Link className="underline underline-offset-4" to="/app/docs/reverse-proxy">Set up HTTPS</Link> and open Terrence at that address before copying the settings.</p>}
            <p className="text-xs text-muted-foreground">{localExecution ? "Plans execute on your computer. Terrence stores the state." : "The run appears here when the CLI uploads your configuration."}</p>
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {usesServerCode && canQueueRun && <Link className={buttonVariants({ size: "sm" })} to={`${workspacePath}/runs?new-run=true`}>Start first plan</Link>}
        {canReadVariable && <Link className={buttonVariants({ variant: "outline", size: "sm" })} to={`${workspacePath}/variables`}>Configure variables</Link>}
        {!hasRepository && canUpdate && <Link className="text-sm font-medium text-primary hover:underline" to={`${workspacePath}/settings/version-control`}>Connect a Git repository</Link>}
        <Link className="text-sm font-medium text-primary hover:underline" to="/app/docs/quickstart">Quick start guide</Link>
      </div>
      <div className="rounded-md border border-border bg-muted/20 p-4" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Check run readiness</p>
            <p className="mt-1 text-xs text-muted-foreground">Check configuration, inputs, engine, execution capacity, and storage before the first plan.</p>
          </div>
          <Button size="sm" variant="outline" onClick={runPreflight} disabled={preflightLoading} aria-busy={preflightLoading}>
            {preflightLoading ? <LoaderCircle className="mr-2 size-4 animate-spin" aria-hidden="true" /> : null}
            {preflightLoading ? "Checking…" : "Run preflight"}
          </Button>
        </div>
        {preflightError !== null && <p className="mt-3 text-sm text-destructive">{preflightError}</p>}
        {preflight !== null && (
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              {preflightStatus === "ready"
                ? <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
                : <CircleAlert className="size-4 text-warning" aria-hidden="true" />}
              <span>{preflightStatus === "ready" ? "Ready for a run" : `Run status: ${preflightStatus}`}</span>
            </div>
            {checks.map((item, index): React.JSX.Element => {
              const detail = typeof item.detail === "string" ? item.detail : "No detail was returned.";
              const id = typeof item.id === "string" ? item.id : `check-${index}`;
              const status = typeof item.status === "string" ? item.status : "unknown";
              return (
                <div key={`${id}-${index}`} className="flex items-start justify-between gap-3 text-xs">
                  <span className="font-medium text-foreground">{id}</span>
                  <span className="text-right text-muted-foreground"><span className="font-medium text-foreground">{status}</span> — {detail}</span>
                </div>
              );
            })}
            {preflight.attributes?.["can-run-anyway"] === true && preflightStatus === "unknown" && usesServerCode && canQueueRun && (
              <Link className={buttonVariants({ variant: "outline", size: "sm" })} to={`${workspacePath}/runs?new-run=true`}>Run anyway</Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
