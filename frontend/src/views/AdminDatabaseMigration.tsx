import { Terrence } from "../components/brand/Terrence";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchApi } from "../lib/api";
import type { JsonValue } from "../lib/json";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";
import { PageHeader, PageShell } from "../components/PageHeader";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Minus,
  Power,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { Callout } from "@/components/ui/callout";

type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";

type WizardStep = {
  key: string;
  status: StepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  detail: string | null;
  error: string | null;
};

type VerifyResult = {
  table: string;
  sourceCount: number;
  targetCount: number;
  countMatch: boolean;
  digestMatch: boolean | null;
  digestSkipped: string | null;
};

type MigrationReport = {
  triggersSkipped: number;
  defaultsDropped: string[];
  checksSkipped: string[];
  indexesSkipped: string[];
  fkViolations: { table: string; constraint: string; error: string }[];
  journalMatch: boolean;
};

type CopyProgress = {
  table: string;
  rows: number;
  totalTables: number;
  doneTables: number;
};

type WizardState = {
  id: string;
  phase: string;
  createdAt: string;
  updatedAt: string;
  targetUrl: string;
  targetMasked: string;
  steps: WizardStep[];
  verification: VerifyResult[] | null;
  report: MigrationReport | null;
  error: string | null;
  copyProgress: CopyProgress | null;
};

type StatusBody = {
  wizard: WizardState | null;
  running: boolean;
  "source-database": { path: string; memory: boolean } | null;
  "restart-disabled": boolean;
  "environment-database-url": string | null;
};

const ACTIVE_PHASES = new Set(["draining", "copying", "verifying"]);

const STEP_LABELS = {
  compatibility: "Compatibility check",
  maintenance: "Maintenance mode",
  drain: "Drain active work",
  checkpoint: "WAL checkpoint",
  schema: "Create target schema",
  copy: "Copy records",
  verify: "Verify integrity",
};

function stepSymbol(status: StepStatus): React.JSX.Element {
  switch (status) {
    case "running":
      return <Spinner className="size-3.5" />;
    case "passed":
      return <Check className="size-3.5 text-success" aria-hidden />;
    case "failed":
      return <X className="size-3.5 text-destructive" aria-hidden />;
    case "skipped":
      return <Minus className="size-3.5 text-muted-foreground" aria-hidden />;
    case "pending":
      return <span className="size-3.5 rounded-full border border-border" aria-hidden />;
  }
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "idle": return "Idle";
    case "draining": return "Draining active work";
    case "copying": return "Copying records";
    case "verifying": return "Verifying the target";
    case "ready_to_switch": return "Ready to switch";
    case "switched": return "Switched to PostgreSQL";
    case "interrupted": return "Interrupted";
    case "failed": return "Failed";
    case "aborted": return "Aborted";
    default: return phase;
  }
}

function Section({
  defaultOpen,
  title,
  children,
}: Readonly<{ defaultOpen: boolean; title: string; children: React.ReactNode }>): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-border first:border-t-0">
      <button
        className="flex w-full items-center gap-1.5 py-2.5 text-left text-sm font-medium text-foreground hover:text-primary"
        onClick={(): void => { setOpen((v): boolean => !v); }}
        type="button"
      >
        {open ? <ChevronDown className="size-4 text-muted-foreground" aria-hidden /> : <ChevronRight className="size-4 text-muted-foreground" aria-hidden />}
        {title}
      </button>
      {open && <div className="pb-3">{children}</div>}
    </div>
  );
}

function Field({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] items-start gap-3 py-1.5 text-sm">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

export function AdminDatabaseMigration(): React.JSX.Element {
  const [status, setStatus] = useState<StatusBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [compatResult, setCompatResult] = useState<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] } | null>(null);
  const [confirmStart, setConfirmStart] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const body = (await fetchApi("/admin/db-migration/status")) as { data: StatusBody };
      setStatus(body.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect((): void => {
    void load();
  }, [load]);

  useEffect((): (() => void) => {
    // Poll adaptively: while a job is running, refresh every 2 seconds;
    // otherwise settle down to 15 seconds. The timeout is rescheduled on
    // every status change and cleared on unmount.
    // The backend reports wizard: null when no migration state exists yet.
    if (pollTimer.current !== null) clearTimeout(pollTimer.current);
    const active = status !== null && (status.running || (status.wizard !== null && ACTIVE_PHASES.has(status.wizard.phase)));
    pollTimer.current = setTimeout((): void => { void load(); }, active ? 2_000 : 15_000);
    return (): void => { if (pollTimer.current !== null) clearTimeout(pollTimer.current); };
  }, [status, error, load]);

  const act = useCallback(async (path: string, method: string, body?: JsonValue): Promise<JsonValue> => {
    setError(null);
    return fetchApi<JsonValue>(`/admin/db-migration/${path}`, {
      method,
      ...(body === undefined ? undefined : { body: JSON.stringify(body) }),
    });
  }, []);

  const runAction = useCallback(async (path: string, method: string, body?: JsonValue, thenLoad = true): Promise<void> => {
    setBusy(path);
    try {
      await act(path, method, body);
      if (thenLoad) await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [act, load]);

  const wizard = status?.wizard ?? null;
  const phase = wizard?.phase ?? "idle";
  const active = status?.running === true || ACTIVE_PHASES.has(phase);
  const terminalFailed = phase === "failed" || phase === "aborted" || phase === "interrupted";

  return (
    <PageShell variant="form">
      <PageHeader
        breadcrumbs={[
          { label: "Admin", to: "/app/admin" },
          { label: "Database" },
        ]}
        title="Database"
        description="Migrate the backend database from SQLite to PostgreSQL. The source database stays untouched as the rollback image; the switch is a single boot-config write followed by a restart."
      />

      {error !== null && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>{error}</div>
        </div>
      )}

      {status !== null && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="size-4 text-muted-foreground" aria-hidden />
              Migration status
            </CardTitle>
            <CardDescription>
              Source database:{" "}
              <span className="font-mono text-xs">
                {status["source-database"] === null ? "none (PostgreSQL backend)" : status["source-database"].path}
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {active && wizard?.steps.some((step): boolean => step.key === "maintenance" && step.status === "passed") === true && <div className="flex items-center gap-4 rounded-lg border bg-muted/30 p-4"><Terrence pose="maintenance" className="w-28" /><div><h2 className="font-heading font-semibold">Maintenance mode</h2><p className="mt-1 text-sm text-muted-foreground">New runs are paused while the database migration is in progress.</p></div></div>}
            <div className="flex flex-wrap items-center gap-3">
              <span
                aria-live="polite"
                aria-atomic="true"
                className={cn(
                  "font-medium",
                  active && "text-warning-text",
                  phase === "ready_to_switch" && "text-success",
                  phase === "switched" && "text-success",
                  terminalFailed && "text-destructive",
                )}
              >
                {phaseLabel(phase)}
              </span>
              {wizard?.targetMasked !== "" && wizard?.targetMasked !== undefined && (
                <span className="font-mono text-xs text-muted-foreground">{wizard.targetMasked}</span>
              )}
              {active && <Spinner className="size-4" />}
            </div>

            {wizard?.error !== null && wizard?.error !== undefined && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {wizard.error}
              </div>
            )}

            {status["environment-database-url"] !== null && (
              <Callout tone="warning" className="p-3">
                {status["environment-database-url"]}
              </Callout>
            )}

            {wizard !== null && wizard.steps.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Steps</div>
                <ul className="space-y-1">
                  {wizard.steps.map((step): React.JSX.Element => {
                    // SAFETY: unknown migration steps fall back to the raw step key below.
                    const stepLabel = Object.prototype.hasOwnProperty.call(STEP_LABELS, step.key)
                      ? STEP_LABELS[step.key as keyof typeof STEP_LABELS]
                      : step.key;
                    return (
                    <li key={step.key} className="flex items-center gap-2 text-sm">
                      {stepSymbol(step.status)}
                      <span className={cn(step.status === "failed" && "text-destructive")}>
                        {stepLabel}
                      </span>
                      {step.detail !== null && (
                        <span className="truncate font-mono text-xs text-muted-foreground">{step.detail}</span>
                      )}
                      {step.error !== null && <span className="text-xs text-destructive">{step.error}</span>}
                    </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {wizard?.copyProgress !== null && wizard?.copyProgress !== undefined && (
              <div className="text-sm text-muted-foreground">
                Copying <span className="font-medium text-foreground">{wizard.copyProgress.table}</span> —{" "}
                {wizard.copyProgress.doneTables}/{wizard.copyProgress.totalTables} tables,{" "}
                {wizard.copyProgress.rows.toLocaleString()} rows in the current table
              </div>
            )}

            {phase === "ready_to_switch" && (
              <div className="space-y-3">
                <div className="text-sm text-muted-foreground">
                  Verification passed: every table matches by row count and content digest. Switch the boot
                  configuration to PostgreSQL, then restart the process.
                </div>
                {wizard?.verification !== null && wizard?.verification !== undefined && wizard.verification.length > 0 && (
                  <Section defaultOpen={false} title={`Verification (${wizard.verification.length} tables)`}>
                    <div className="overflow-x-auto rounded-lg border border-border">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border text-left text-muted-foreground">
                            <th className="px-2 py-1.5 font-medium">Table</th>
                            <th className="px-2 py-1.5 font-medium">Source</th>
                            <th className="px-2 py-1.5 font-medium">Target</th>
                            <th className="px-2 py-1.5 font-medium">Digest</th>
                          </tr>
                        </thead>
                        <tbody>
                          {wizard.verification.map((row): React.JSX.Element => (
                            <tr key={row.table} className="border-b border-border last:border-b-0">
                              <td className="px-2 py-1.5 font-mono">{row.table}</td>
                              <td className="px-2 py-1.5">{row.sourceCount.toLocaleString()}</td>
                              <td className="px-2 py-1.5">{row.targetCount.toLocaleString()}</td>
                              <td className={cn("px-2 py-1.5", row.digestMatch === false && "text-destructive")}>
                                {row.digestMatch === null
                                  ? (row.digestSkipped ?? "skipped")
                                  : row.digestMatch ? "match" : "MISMATCH"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Section>
                )}
                {wizard?.report !== null && wizard?.report !== undefined && (
                  <Section defaultOpen={false} title="Migration report">
                    <div className="space-y-1">
                      <Field label="Triggers skipped" children={<span className={wizard.report.triggersSkipped > 0 ? "text-warning-text" : undefined}>{wizard.report.triggersSkipped}</span>} />
                      <Field label="Defaults dropped" children={<span className={wizard.report.defaultsDropped.length > 0 ? "text-warning-text" : undefined}>{wizard.report.defaultsDropped.length > 0 ? wizard.report.defaultsDropped.join(", ") : "none"}</span>} />
                      <Field label="Checks skipped" children={<span className={wizard.report.checksSkipped.length > 0 ? "text-warning-text" : undefined}>{wizard.report.checksSkipped.length > 0 ? wizard.report.checksSkipped.join(", ") : "none"}</span>} />
                      <Field label="Indexes skipped" children={<span className={wizard.report.indexesSkipped.length > 0 ? "text-warning-text" : undefined}>{wizard.report.indexesSkipped.length > 0 ? wizard.report.indexesSkipped.join(", ") : "none"}</span>} />
                      <Field label="FK violations" children={<span className={wizard.report.fkViolations.length > 0 ? "text-destructive" : undefined}>{wizard.report.fkViolations.length}</span>} />
                      <Field label="Journal match" children={wizard.report.journalMatch ? "ok" : "mismatch"} />
                    </div>
                  </Section>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    disabled={status["environment-database-url"] !== null}
                    onClick={(): void => { void runAction("switch", "POST"); }}
                  >
                    <ArrowRight className="size-4" aria-hidden />
                    Switch to PostgreSQL
                  </Button>
                  <Button variant="outline" onClick={(): void => { void runAction("cancel", "POST"); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {phase === "switched" && (
              <div className="space-y-3">
                <div className="text-sm text-muted-foreground">
                  The boot configuration now points at PostgreSQL. Restart the process to boot on the new backend;
                  the SQLite database remains as the rollback image.
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={(): void => { void runAction("restart", "POST"); }}>
                    <Power className="size-4" aria-hidden />
                    Restart process
                  </Button>
                  {status["restart-disabled"] && (
                    <span className="text-xs text-muted-foreground">
                      Restart is suppressed in this environment; restart the process manually.
                    </span>
                  )}
                </div>
              </div>
            )}

            {terminalFailed && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button variant="outline" onClick={(): void => { void runAction("cancel", "POST"); }}>
                  Clear
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!active && (phase === "idle" || phase === "failed" || phase === "aborted" || phase === "interrupted") && (
        <Card>
          <CardHeader variant="danger">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4" aria-hidden="true" />
              Start a migration
            </CardTitle>
            <CardDescription>
              Enter the target PostgreSQL connection URL. The target database must be empty; the wizard creates the
              schema and copies all records. The backend enters maintenance mode for the duration of the copy.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              This changes the storage backend and puts the instance into maintenance mode. Verify the target and rollback plan before continuing.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                aria-label="PostgreSQL connection URL"
                className="font-mono text-xs"
                onChange={(event): void => { setUrl(event.target.value); }}
                placeholder="postgres://user:password@host:5432/terrence"
                spellCheck={false}
                value={url}
              />
              <div className="flex shrink-0 gap-2">
                <Button
                  disabled={url.trim() === "" || busy !== null}
                  onClick={(): void => {
                    setBusy("test-connection");
                    setTestResult(null);
                    act("test-connection", "POST", { data: { attributes: { url } } })
                      .then((body): void => {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
                        const result = (body as { data: { ok?: boolean; detail?: string } }).data;
                        setTestResult(result.ok === false ? `Connection failed: ${result.detail ?? "unknown error"}` : "Connection OK");
                      })
                      .catch((err: unknown): void => {
                        setError(err instanceof Error ? err.message : String(err));
                      })
                      .finally((): void => { setBusy(null); });
                  }}
                  variant="outline"
                >
                  <RefreshCw className="size-4" aria-hidden />
                  Test connection
                </Button>
                <Button
                  disabled={url.trim() === "" || busy !== null}
                  onClick={(): void => {
                    setBusy("compatibility");
                    setCompatResult(null);
                    act("compatibility", "POST", { data: { attributes: { url } } })
                      .then((body): void => {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
                        setCompatResult((body as { data: { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] } }).data);
                      })
                      .catch((err: unknown): void => {
                        setError(err instanceof Error ? err.message : String(err));
                      })
                      .finally((): void => { setBusy(null); });
                  }}
                  variant="outline"
                >
                  <Check className="size-4" aria-hidden />
                  Compatibility
                </Button>
              </div>
            </div>

            {busy === "test-connection" && <div className="text-sm text-muted-foreground">Testing connection…</div>}
            {testResult !== null && (
              <div className={cn("text-sm", testResult.startsWith("Connection failed") ? "text-destructive" : "text-success")}>
                {testResult}
              </div>
            )}
            {busy === "compatibility" && <div className="text-sm text-muted-foreground">Checking target…</div>}

            {compatResult !== null && (
              <ul className="space-y-1 text-sm">
                {compatResult.checks.map((check): React.JSX.Element => (
                  <li key={check.name} className="flex items-center gap-2">
                    {check.ok
                      ? <Check className="size-3.5 text-success" aria-hidden />
                      : <X className="size-3.5 text-destructive" aria-hidden />}
                    <span className={cn(!check.ok && "text-destructive")}>{check.name}</span>
                    {check.detail !== "" && <span className="font-mono text-xs text-muted-foreground">{check.detail}</span>}
                  </li>
                ))}
              </ul>
            )}

            {!confirmStart ? (
              <Button
                disabled={url.trim() === "" || busy !== null || status?.running === true}
                onClick={(): void => { setConfirmStart(true); }}
              >
                Start migration
              </Button>
            ) : (
              <Callout
                tone="warning"
                className="p-3"
                actions={
                  <>
                    <Button
                      disabled={busy !== null}
                      onClick={(): void => {
                        setConfirmStart(false);
                        void runAction("start", "POST", { data: { attributes: { url } } });
                      }}
                    >
                      Confirm start
                    </Button>
                    <Button variant="outline" onClick={(): void => { setConfirmStart(false); }}>Back</Button>
                  </>
                }
              >
                The backend enters maintenance mode: existing runs finish, new runs are blocked until the copy
                completes and you decide to switch.
              </Callout>
            )}
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}
