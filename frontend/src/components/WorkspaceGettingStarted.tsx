import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, CircleAlert, CircleHelp, Copy, Loader2, LoaderCircle } from "lucide-react";
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

type ReadinessState = "ready" | "missing" | "unknown" | "checking";

type ReadinessCheck = Readonly<{
  id: string;
  label: string;
  state: ReadinessState;
  detail: string;
  href?: string | undefined;
}>;

function ReadinessIcon({ state }: Readonly<{ state: ReadinessState }>): React.JSX.Element {
  if (state === "checking") return <Loader2 className="mt-0.5 size-4 animate-spin text-muted-foreground" aria-hidden="true" />;
  if (state === "ready") return <CheckCircle2 className="mt-0.5 size-4 text-success" aria-hidden="true" />;
  if (state === "missing") return <CircleAlert className="mt-0.5 size-4 text-warning" aria-hidden="true" />;
  return <CircleHelp className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />;
}

function readinessStateLabel(state: ReadinessState): string {
  if (state === "ready") return "Configured";
  if (state === "missing") return "Action needed";
  if (state === "checking") return "Checking";
  return "Unable to verify";
}

export function WorkspaceGettingStarted({
  orgName,
  workspaceName,
  engine,
  source,
  workspaceId,
  executionMode,
  agentPoolConfigured,
  hasRepository,
  localExecution,
  canQueueRun,
  canUpdate,
  canReadVariable,
  locked,
  compact = false,
}: Readonly<{
  workspaceId?: string;
  orgName: string;
  workspaceName: string;
  engine: string;
  source?: string | undefined;
  executionMode?: string | undefined;
  agentPoolConfigured?: boolean | undefined;
  hasRepository: boolean;
  localExecution: boolean;
  canQueueRun: boolean;
  canUpdate: boolean;
  canReadVariable: boolean;
  locked?: boolean;
  compact?: boolean | undefined;
}>): React.JSX.Element {
  const [preflight, setPreflight] = useState<PreflightData | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const workspacePath = `/app/${encodeURIComponent(orgName)}/workspaces/${encodeURIComponent(workspaceName)}`;
  const cli = engine === "tofu" ? "tofu" : "terraform";
  const hostname = window.location.host;
  const effectiveExecutionMode = executionMode ?? "remote";
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

  const preflightChecks = Array.isArray(preflight?.attributes?.checks)
    ? (preflight.attributes.checks as PreflightCheck[])
    : [];
  const preflightStatus = typeof preflight?.attributes?.status === "string" ? preflight.attributes.status : "unknown";
  const isLocked = locked === true;
  const [inputState, setInputState] = useState<ReadinessState>(workspaceId === undefined ? "unknown" : "checking");
  const [sandboxState, setSandboxState] = useState<ReadinessState>(workspaceId === undefined ? "unknown" : "checking");

  useEffect((): (() => void) => {
    if (workspaceId === undefined) return (): void => undefined;
    const controller = new AbortController();
    setInputState(canReadVariable ? "checking" : "unknown");
    if (canReadVariable) {
      void fetchApi<{ data?: unknown[] }>(
        `/workspaces/${encodeURIComponent(workspaceId)}/vars?page[size]=1`,
        { signal: controller.signal },
      )
        .then((response): void => {
          if (controller.signal.aborted) return;
          setInputState(Array.isArray(response.data) && response.data.length > 0 ? "ready" : "missing");
        })
        .catch((): void => {
          if (!controller.signal.aborted) setInputState("unknown");
        });
    }
    setSandboxState("checking");
    void fetch("/api/v2/meta", { credentials: "same-origin", signal: controller.signal })
      .then(async (response): Promise<ReadinessState> => {
        if (!response.ok) return "unknown";
        const payload = await response.json() as {
          data?: { attributes?: { "run-sandbox"?: { enabled?: boolean; available?: boolean } } };
        };
        const sandbox = payload.data?.attributes?.["run-sandbox"];
        if (sandbox?.enabled !== true) return "ready";
        return sandbox.available === true ? "ready" : "missing";
      })
      .catch((): ReadinessState => "unknown")
      .then((state): void => {
        if (!controller.signal.aborted) setSandboxState(state);
      });
    return (): void => { controller.abort(); };
  }, [canReadVariable, workspaceId]);

  const checks = useMemo((): readonly ReadinessCheck[] => {
    const configurationReady = localExecution || hasRepository || source === "local";
    const targetReady = effectiveExecutionMode === "agent"
      ? agentPoolConfigured === true
      : localExecution || effectiveExecutionMode === "remote" || source === "local";
    const targetState: ReadinessState = effectiveExecutionMode === "agent" && agentPoolConfigured === undefined
      ? "unknown"
      : targetReady ? "ready" : "missing";
    const credentialReady = localExecution || hasRepository || source === "local";
    const executionDetail = effectiveExecutionMode === "agent"
      ? agentPoolConfigured === true ? "An agent pool is assigned; the first plan verifies that an agent is online." : "Assign an agent pool before queueing a run."
      : localExecution ? "The CLI is the execution target for this workspace." : "The Terrence worker is the execution target.";
    return [
      {
        id: "configuration",
        label: "Configuration source",
        state: configurationReady ? "ready" : "missing",
        detail: configurationReady ? "A configuration source is connected." : "Connect a repository or configure the CLI backend.",
        href: configurationReady ? undefined : `${workspacePath}/settings/version-control`,
      },
      {
        id: "engine",
        label: "Engine",
        state: engine.trim() === "" ? "missing" : "ready",
        detail: engine.trim() === "" ? "Select Terraform or OpenTofu in workspace settings." : `${engine === "tofu" ? "OpenTofu" : "Terraform"} is configured; the first plan verifies its availability.`,
        href: engine.trim() === "" ? `${workspacePath}/settings` : undefined,
      },
      {
        id: "inputs",
        label: "Required inputs",
        state: inputState,
        detail: inputState === "ready" ? "Variable access is configured; code-specific requirements are verified by a plan." : inputState === "missing" ? "No workspace variables are configured yet; check the configuration requirements." : inputState === "checking" ? "Checking whether a variable source is available. Secret values are never fetched for this check." : "Unable to verify inputs for this user. Review variables before queueing a run.",
        href: canReadVariable ? `${workspacePath}/variables` : undefined,
      },
      {
        id: "target",
        label: "Execution target",
        state: targetState,
        detail: executionDetail,
        href: targetState === "missing" ? `${workspacePath}/settings` : undefined,
      },
      {
        id: "credentials",
        label: "Credentials mechanism",
        state: credentialReady ? "ready" : "missing",
        detail: credentialReady ? (localExecution ? "Credentials stay with the CLI session." : hasRepository ? "The connected repository supplies the configuration source." : "The server workspace mount supplies the configuration source.") : "Connect a source before credentials can be used.",
        href: credentialReady ? undefined : `${workspacePath}/settings/version-control`,
      },
      {
        id: "sandbox",
        label: "Run capability",
        state: localExecution || effectiveExecutionMode === "agent" ? "unknown" : sandboxState,
        detail: localExecution ? "Local execution does not depend on the server sandbox." : effectiveExecutionMode === "agent" ? "Agent availability is verified when the assigned agent reports readiness." : sandboxState === "missing" ? "The remote run sandbox is unavailable; remote runs will be blocked." : sandboxState === "ready" ? "The remote run sandbox is available." : sandboxState === "checking" ? "Checking remote run capability." : "Unable to verify remote run capability.",
        href: sandboxState === "missing" ? "/app/docs/reverse-proxy" : undefined,
      },
      {
        id: "permission",
        label: "Permission to plan",
        state: canQueueRun ? "ready" : "missing",
        detail: canQueueRun ? "You can queue a plan from this workspace." : "You can review readiness, but an administrator must grant plan permission.",
      },
    ];
  }, [agentPoolConfigured, canQueueRun, canReadVariable, effectiveExecutionMode, engine, hasRepository, inputState, localExecution, sandboxState, source, workspacePath]);

  const nextStep = checks.find((check): boolean => check.state === "missing" || check.state === "unknown");

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">{compact ? "Workspace readiness" : "Ready for your first plan"}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {compact ? "The checks below stay available after a successful workflow so a later run can be diagnosed before it starts."
            : localExecution ? "Connect your CLI to store state in Terrence while running plans on your computer."
            : hasRepository ? "Your repository is connected. Add any required variables, then preview the changes in your code."
            : source === "local" ? "Mount your configuration directory on the Terrence server, then add any variables your code needs."
            : "Connect your existing configuration to this workspace. Your CLI uploads the code; Terrence keeps the state and run history together."}
        </p>
        {isLocked && (
          <p className="mt-2 text-sm font-medium text-warning-text">This workspace is locked. Unlock it before starting a run.</p>
        )}
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
      <ol aria-label="Workspace readiness checks" className="space-y-2">
        {checks.map((check): React.JSX.Element => (
          <li key={check.id} className="flex items-start gap-2 rounded-md border border-border/70 bg-background/60 px-3 py-2">
            <ReadinessIcon state={check.state} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="text-sm font-medium text-foreground">{check.label}</span>
                <span className={`text-xs font-medium ${check.state === "ready" ? "text-success-text" : check.state === "missing" ? "text-warning-text" : "text-muted-foreground"}`}>
                  {readinessStateLabel(check.state)}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{check.detail}</p>
              {check.href !== undefined && (
                <Link className="mt-1 inline-block text-xs font-medium text-primary hover:underline" to={check.href}>
                  Review {check.label.toLocaleLowerCase()}
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>
      {nextStep !== undefined && (
        <p role="status" className="rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-sm text-foreground">
          <span className="font-medium">Next step:</span> {nextStep.detail}
        </p>
      )}
      {!compact && !usesServerCode && (
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
      {!compact && (
        <div className="flex flex-wrap items-center gap-3">
          {usesServerCode && canQueueRun && !isLocked && <Link className={buttonVariants({ size: "sm" })} to={`${workspacePath}/runs?new-run=true`}>Start first plan</Link>}
          {canReadVariable && <Link className={buttonVariants({ variant: "outline", size: "sm" })} to={`${workspacePath}/variables`}>Configure variables</Link>}
          {!hasRepository && canUpdate && <Link className="text-sm font-medium text-primary hover:underline" to={`${workspacePath}/settings/version-control`}>Connect a Git repository</Link>}
          <Link className="text-sm font-medium text-primary hover:underline" to="/app/docs/quickstart">Quick start guide</Link>
        </div>
      )}
      {!compact && <div className="rounded-md border border-border bg-muted/20 p-4" aria-live="polite">
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
            {preflightChecks.map((item, index): React.JSX.Element => {
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
      </div>}
    </div>
  );
}
