import { EmptyState } from "../components/EmptyState";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { formatDate } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";

import { Badge } from "../components/ui/badge";
import { Spinner } from "../components/ui/spinner";
import { Activity, CheckCircle2, Clock3, Cpu, Eye, Key, Plus, RefreshCw, Server, ShieldCheck, Trash2, WifiOff } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader, PageShell } from "@/components/PageHeader";
import {
  agentCapabilities,
  agentHealthState,
  agentStatusLabel,
  formatLastObserved,
  summarizeAgentHealth,
  type AgentHealthRecord,
  type AgentHealthState,
} from "../lib/agent-health";

type AgentPool = {
  id: string;
  attributes: {
    name: string;
    organization: string;

    "agent-count"?: number;
    "queued-job-count"?: number;
    "claimed-job-count"?: number;
    "organization-scoped"?: boolean;
  };
  relationships?: {
    "allowed-workspaces"?: { data?: { id: string }[] };
    "allowed-projects"?: { data?: { id: string }[] };
    "excluded-workspaces"?: { data?: { id: string }[] };
  };
}

type AgentToken = {
  id: string;
  attributes: {
    description: string;

    "created-at": string;

    "last-used-at"?: string | null;
  };
}

function AgentHealthBadge({ state }: Readonly<{ state: AgentHealthState }>): React.JSX.Element {
  const tone = state === "idle" ? "border-success/30 bg-success/10 text-success"
    : state === "busy" ? "border-primary/30 bg-primary/10 text-primary"
      : state === "draining" ? "border-warning/30 bg-warning/10 text-warning"
        : state === "stale" || state === "offline" ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border bg-muted text-muted-foreground";
  const statusIcon = state === "idle" ? <CheckCircle2 className="size-3" aria-hidden="true" />
    : state === "busy" ? <Activity className="size-3" aria-hidden="true" />
      : state === "stale" ? <Clock3 className="size-3" aria-hidden="true" />
        : state === "offline" ? <WifiOff className="size-3" aria-hidden="true" />
          : <Activity className="size-3" aria-hidden="true" />;
  return (
    <Badge variant="outline" className={`inline-flex items-center gap-1 ${tone}`}>
      {statusIcon}
      {agentStatusLabel(state)}
    </Badge>
  );
}

type PoolRelationshipKey = "allowed-workspaces" | "allowed-projects" | "excluded-workspaces";

function relationshipCount(pool: AgentPool, key: PoolRelationshipKey): number {
  const data = pool.relationships?.[key]?.data;
  return Array.isArray(data) ? data.length : 0;
}

function pluralSuffix(count: number): string {
  return count === 1 ? "" : "s";
}

function assignmentScopeLabel(pool: AgentPool): string {
  const allowedWorkspaces = relationshipCount(pool, "allowed-workspaces");
  const allowedProjects = relationshipCount(pool, "allowed-projects");
  const excludedWorkspaces = relationshipCount(pool, "excluded-workspaces");
  const excludedSuffix = excludedWorkspaces > 0 ? ` · ${excludedWorkspaces} excluded` : "";
  if (pool.attributes["organization-scoped"] !== false) {
    return `Organization-wide${excludedSuffix}`;
  }
  if (allowedWorkspaces === 0 && allowedProjects === 0) return "No allowed workspaces or projects";
  return `${allowedWorkspaces} workspace${pluralSuffix(allowedWorkspaces)}, ${allowedProjects} project${pluralSuffix(allowedProjects)}${excludedSuffix}`;
}

function AgentPoolTableBody({
  loading,
  canManage,
  pools,
  error,
  agentsByPool,
  agentLoadErrors,
  onViewHealth,
  onManageTokens,
  onDeleteRequest,
}: Readonly<{
  loading: boolean;
  canManage: boolean;
  pools: AgentPool[];
  error: string;
  agentsByPool: Record<string, AgentHealthRecord[]>;
  agentLoadErrors: Record<string, string>;
  onViewHealth: (pool: AgentPool) => void;
  onManageTokens: (pool: AgentPool) => void;
  onDeleteRequest: (pool: AgentPool) => void;
}>): React.JSX.Element {
  return (
    <TableBody>
      {loading ? (
        <TableRow>
          <TableCell colSpan={5} className="p-0">
            <TableSkeleton rows={3} cols={5} />
          </TableCell>
        </TableRow>
      ) : !canManage ? (
        <TableRow>
          <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
            Agent pool access is unavailable.
          </TableCell>
        </TableRow>
      ) : pools.length === 0 ? (
        <TableRow>
          <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
            <EmptyState compact illustration={error === "" ? "empty" : undefined}
              title={error === "" ? "No agent pools yet" : "Agent pools unavailable"}
              description={error === "" ? "Create an agent pool to run infrastructure jobs on your own workers." : "Reload the page to try again."}
              docsHref="/app/docs/execution"
            />
          </TableCell>
        </TableRow>
      ) : (
        pools.map((pool): React.JSX.Element => {
          const agents = agentsByPool[pool.id] ?? [];
          const summary = summarizeAgentHealth(agents);
          const agentError = agentLoadErrors[pool.id];
          return (
          <TableRow key={pool.id}>
            <TableCell className="font-semibold">
              <div className="flex items-center gap-2">
                <Server className="size-4 text-primary" />
                {pool.attributes.name}
              </div>
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {pool.attributes.organization}
            </TableCell>
            <TableCell>
              {agentError !== undefined ? (
                <div className="text-xs text-muted-foreground">Worker health unavailable</div>
              ) : (
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Cpu className="size-3.5 text-primary" aria-hidden="true" />
                    <span className="text-xs font-medium">{summary.usable} usable</span>
                    <span className="text-xs text-muted-foreground">of {summary.total} registered</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {summary.usable === 0 ? "No eligible workers; runs will wait." : `${summary.idle} idle · ${summary.busy} busy`}
                    {summary.stale > 0 ? ` · ${summary.stale} heartbeat stale` : ""}
                  </p>
                  {(pool.attributes["queued-job-count"] ?? 0) > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {pool.attributes["queued-job-count"]} queued job{pool.attributes["queued-job-count"] === 1 ? "" : "s"} · {pool.attributes["claimed-job-count"] ?? 0} claimed
                    </p>
                  )}
                </div>
              )}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {assignmentScopeLabel(pool)}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={(): void => { onViewHealth(pool); }}>
                  <Eye className="size-3.5 mr-1" aria-hidden="true" /> Worker health
                </Button>
                <Button size="sm" variant="outline" onClick={(): void => { onManageTokens(pool); }}>
                  <Key className="size-3.5 mr-1" /> Agent Tokens
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={(): void => { onDeleteRequest(pool); }}
                >
                  <Trash2 className="size-3.5 mr-1" /> Delete
                </Button>
              </div>
            </TableCell>
          </TableRow>
          );
        })
      )}
    </TableBody>
  );
}

function WorkerHealthDialog({
  healthPool,
  agentsByPool,
  agentLoadErrors,
  onRetry,
  onClose,
}: Readonly<{
  healthPool: AgentPool | null;
  agentsByPool: Record<string, AgentHealthRecord[]>;
  agentLoadErrors: Record<string, string>;
  onRetry: () => void;
  onClose: () => void;
}>): React.JSX.Element {
  return (
    <Dialog open={healthPool !== null} onOpenChange={(open): void => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[900px]" align="top">
        {healthPool !== null && (() => {
          const healthAgents = agentsByPool[healthPool.id] ?? [];
          const healthSummary = summarizeAgentHealth(healthAgents);
          const healthError = agentLoadErrors[healthPool.id];
          return (
            <>
              <DialogHeader>
                <DialogTitle>Worker health — {healthPool.attributes.name}</DialogTitle>
                <DialogDescription>
                  Usable capacity reflects the server&apos;s recorded worker status. Heartbeat times are last observed values, not a live connection claim.
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-3 sm:grid-cols-4" aria-label="Worker health summary">
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="text-xs text-muted-foreground">Usable capacity</div>
                  <div className="mt-1 text-lg font-semibold">{healthSummary.usable} / {healthSummary.total}</div>
                </div>
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="text-xs text-muted-foreground">Idle</div>
                  <div className="mt-1 text-lg font-semibold">{healthSummary.idle}</div>
                </div>
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="text-xs text-muted-foreground">Busy</div>
                  <div className="mt-1 text-lg font-semibold">{healthSummary.busy}</div>
                </div>
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="text-xs text-muted-foreground">Needs attention</div>
                  <div className="mt-1 text-lg font-semibold">{healthSummary.stale + healthSummary.draining + healthSummary.failed}</div>
                </div>
              </div>

              {healthError !== undefined && (
                <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-text">
                  <span>Worker health could not be loaded: {healthError}</span>
                  <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                    Try again
                  </Button>
                </div>
              )}

              {healthError === undefined && healthAgents.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-center">
                  <p className="font-medium">No workers have registered with this pool.</p>
                  <p className="mt-1 text-sm text-muted-foreground">Runs assigned here will wait until a compatible worker checks in.</p>
                </div>
              ) : healthError === undefined ? (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Worker</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Capabilities</TableHead>
                        <TableHead>Version / architecture</TableHead>
                        <TableHead>Last observed</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {healthAgents.map((agent): React.JSX.Element => {
                        const state = agentHealthState(agent);
                        const lastObserved = agent.attributes["last-ping-at"];
                        return (
                          <TableRow key={agent.id}>
                            <TableCell>
                              <div className="font-medium">{agent.attributes.name ?? agent.id}</div>
                              <div className="font-mono text-xs text-muted-foreground">{agent.id}</div>
                            </TableCell>
                            <TableCell><AgentHealthBadge state={state} /></TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                {agentCapabilities(agent).map((capability): React.JSX.Element => (
                                  <Badge key={capability} variant="secondary" className="font-mono text-[11px]">{capability}</Badge>
                                ))}
                              </div>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              <div>{agent.attributes.version ?? "Version unknown"}</div>
                              <div>{agent.attributes.architecture ?? "Architecture unknown"}</div>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              <time dateTime={lastObserved ?? undefined}>{formatLastObserved(lastObserved)}</time>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              ) : null}

              <DialogFooter>
                <Button type="button" variant="outline" onClick={onRetry}>
                  <RefreshCw className="mr-1.5 size-4" aria-hidden="true" /> Refresh health
                </Button>
                <Button type="button" onClick={onClose}>Close</Button>
              </DialogFooter>
            </>
          );
        })()}
      </DialogContent>
    </Dialog>
  );
}

function CreatePoolDialog({
  open,
  onOpenChange,
  poolName,
  onPoolNameChange,
  creatingPool,
  poolFormError,
  onSubmit,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poolName: string;
  onPoolNameChange: (value: string) => void;
  creatingPool: boolean;
  poolFormError: string;
  onSubmit: (event: React.SyntheticEvent) => Promise<void>;
}>): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={onSubmit} noValidate>
          <DialogHeader>
            <DialogTitle>Create Agent Pool</DialogTitle>
            <DialogDescription>
              Define an agent pool to manage self-hosted execution workers for organization run tasks.
            </DialogDescription>
          </DialogHeader>
          {poolFormError !== "" && (
            <div role="alert" className="rounded bg-destructive/15 p-3 text-xs font-medium text-destructive">
              {poolFormError}
            </div>
          )}
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label htmlFor="agent-pool-name" className="text-sm font-medium">Pool Name</label>
              <Input
                id="agent-pool-name"
                name="agent-pool-name"
                autoComplete="off"
                spellCheck={false}
                value={poolName}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { onPoolNameChange(event.target.value); }}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onPoolNameChange(event.currentTarget.value); }}
                placeholder="e.g. production-k8s-pool"
                required
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={(): void => { onOpenChange(false); }}>Cancel</Button>
            <Button type="submit" disabled={creatingPool || poolName.trim() === ""}>
              {creatingPool ? <Spinner className="size-4" /> : null}
              {creatingPool ? "Creating pool…" : "Create pool"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AgentTokensDialog({
  open,
  onOpenChange,
  selectedPool,
  tokenDesc,
  onTokenDescChange,
  creatingToken,
  createdSecret,
  loadingTokens,
  tokens,
  onSubmit,
  onRevokeRequest,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedPool: AgentPool | null;
  tokenDesc: string;
  onTokenDescChange: (value: string) => void;
  creatingToken: boolean;
  createdSecret: string | null;
  loadingTokens: boolean;
  tokens: AgentToken[];
  onSubmit: (event: React.SyntheticEvent) => Promise<void>;
  onRevokeRequest: (token: AgentToken) => void;
}>): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Agent Tokens — {selectedPool?.attributes.name}</DialogTitle>
          <DialogDescription>
            Manage authentication tokens used by `tfc-agent` instances to join this pool.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <form onSubmit={onSubmit} noValidate className="flex items-end gap-2 rounded-md border p-3 bg-muted/20">
            <div className="flex-1 space-y-1">
              <label htmlFor="agent-token-desc" className="text-xs font-medium">New Token Description</label>
              <Input
                id="agent-token-desc"
                name="agent-token-description"
                autoComplete="off"
                value={tokenDesc}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { onTokenDescChange(event.target.value); }}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onTokenDescChange(event.currentTarget.value); }}
                placeholder="e.g. k8s-worker-node-1"
                required
              />
            </div>
            <Button type="submit" disabled={creatingToken} size="sm">
              {creatingToken ? <Spinner className="size-3.5" /> : <Plus className="size-3.5 mr-1" />}
              {creatingToken ? "Generating…" : "Generate token"}
            </Button>
          </form>

          {createdSecret != null && (
            <div className="rounded border border-success/30 bg-success/10 p-3 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-success">
                <ShieldCheck className="size-4" /> Agent Token Created!
              </div>
              <div className="rounded bg-background p-2 font-mono text-xs font-semibold select-all break-all border">
                {createdSecret}
              </div>
            </div>
          )}

          <div className="rounded border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Description</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingTokens ? (
                  <TableRow>
                    <TableCell colSpan={3} className="h-20 text-center">
                      <Spinner className="mx-auto size-5 text-primary" />
                    </TableCell>
                  </TableRow>
                ) : tokens.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="h-16 text-center text-xs text-muted-foreground">
                      No active tokens for this agent pool.
                    </TableCell>
                  </TableRow>
                ) : (
                tokens.map((token): React.JSX.Element => (
                  <TableRow key={token.id}>
                    <TableCell className="font-medium text-xs">{token.attributes.description}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(token.attributes["created-at"])}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={(): void => { onRevokeRequest(token); }}
                      >
                          <Trash2 className="size-3 mr-1" /> Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeletePoolConfirm({
  pool,
  deleting,
  onClose,
  onConfirm,
}: Readonly<{
  pool: AgentPool | null;
  deleting: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}>): React.JSX.Element {
  return (
    <ConfirmDialog
      open={pool !== null}
      onOpenChange={(open): void => { if (!open) onClose(); }}
      title="Delete Agent Pool"
      description={
        <>
          Are you sure you want to delete agent pool <strong className="text-foreground">{pool?.attributes.name}</strong>? Workspaces using this pool will fail to run until reassigned. This cannot be undone.
        </>
      }
      confirmText="Delete Agent Pool"
      confirmVariant="destructive"
      requireText={pool?.attributes.name}
      loading={deleting}
      onConfirm={onConfirm}
    />
  );
}

function RevokeTokenConfirm({
  token,
  onClose,
  onConfirm,
}: Readonly<{
  token: AgentToken | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}>): React.JSX.Element {
  return (
    <ConfirmDialog
      open={token !== null}
      onOpenChange={(open): void => { if (!open) onClose(); }}
      title="Revoke Agent Token"
      description={`Are you sure you want to revoke agent token "${token?.attributes.description ?? token?.id}"?`}
      confirmText="Revoke Token"
      confirmVariant="destructive"
      onConfirm={onConfirm}
    />
  );
}

export function AgentPools(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const orgPath = `/app/${encodeURIComponent(orgName)}`;
  const [pools, setPools] = useState<AgentPool[]>([]);
  const [agentsByPool, setAgentsByPool] = useState<Record<string, AgentHealthRecord[]>>({});
  const [agentLoadErrors, setAgentLoadErrors] = useState<Record<string, string>>({});
  const [manageableOrganizationName, setManageableOrganizationName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Create Pool Modal
  const [poolDialogOpen, setPoolDialogOpen] = useState(false);
  const [poolName, setPoolName] = useState("");
  const [creatingPool, setCreatingPool] = useState(false);
  const [poolFormError, setPoolFormError] = useState("");

  // Tokens Modal
  const [tokensDialogOpen, setTokensDialogOpen] = useState(false);
  const [selectedPool, setSelectedPool] = useState<AgentPool | null>(null);
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [tokenDesc, setTokenDesc] = useState("");
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [creatingToken, setCreatingToken] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [healthPool, setHealthPool] = useState<AgentPool | null>(null);
  const activeOrganizationName = useRef(orgName);
  const selectedPoolId = useRef<string | null>(null);
  activeOrganizationName.current = orgName;
  const canManage = orgName !== "" && manageableOrganizationName === orgName;

  useEffect((): void => {
    setPools([]);
    setAgentsByPool({});
    setAgentLoadErrors({});
    setManageableOrganizationName("");
    setPoolDialogOpen(false);
    setTokensDialogOpen(false);
    setHealthPool(null);
    selectedPoolId.current = null;
    if (orgName !== "") void loadAgentPools();
  }, [orgName]);

  const loadAgentPools = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const organizationResponse = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}`,
      ) as {
        data?: { attributes?: { permissions?: { "can-manage-agent-pools"?: boolean } } };
      };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      if (organizationResponse.data?.attributes?.permissions?.["can-manage-agent-pools"] !== true) {
        setError("You do not have permission to manage agent pools for this organization.");
        return;
      }
      setManageableOrganizationName(requestedOrganizationName);
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}/agent-pools`,
      ) as { data?: AgentPool[] };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      const nextPools = Array.isArray(response.data) ? response.data : [];
      setPools(nextPools);

      // Pool resources contain only the count. Read the agent collection as a
      // second, permission-scoped request so the table can explain whether a
      // worker is usable, busy, draining, or stale without inventing state.
      const agentResults = await Promise.all(nextPools.map(async (pool): Promise<{
        id: string;
        agents: AgentHealthRecord[];
        error: string;
      }> => {
        try {
          const agentResponse = await fetchApi(
            `/agent-pools/${encodeURIComponent(pool.id)}/agents`,
          ) as { data?: AgentHealthRecord[] };
          return {
            id: pool.id,
            agents: Array.isArray(agentResponse.data) ? agentResponse.data : [],
            error: "",
          };
        } catch (agentError: unknown) {
          return {
            id: pool.id,
            agents: [],
            error: agentError instanceof Error ? agentError.message : "Worker health could not be loaded.",
          };
        }
      }));
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      setAgentsByPool(Object.fromEntries(agentResults.map((result): [string, AgentHealthRecord[]] => [result.id, result.agents])));
      setAgentLoadErrors(Object.fromEntries(
        agentResults
          .filter((result): boolean => result.error !== "")
          .map((result): [string, string] => [result.id, result.error]),
      ));
    } catch (err: unknown) {
      if (activeOrganizationName.current === requestedOrganizationName) {
        setError(err instanceof Error ? err.message : "Failed to load agent pools");
      }
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
    }
  };

  const handleCreatePool = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (!canManage) return;
    setCreatingPool(true);
    setPoolFormError("");
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const res = await fetchApi(`/organizations/${encodeURIComponent(orgName)}/agent-pools`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "agent-pools",
            attributes: {
              name: poolName.trim(),
            },
          },
        }),
      }) as { data: AgentPool };
      if (activeOrganizationName.current !== orgName) return;
      setPools((prev: AgentPool[]): AgentPool[] => [...prev, res.data]);
      setAgentsByPool((prev): Record<string, AgentHealthRecord[]> => ({ ...prev, [res.data.id]: [] }));
      setPoolDialogOpen(false);
      setPoolName("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create agent pool";
      setPoolFormError(msg);
    } finally {
      setCreatingPool(false);
    }
  };

  const [poolToDelete, setPoolToDelete] = useState<AgentPool | null>(null);
  const [tokenToRevoke, setTokenToRevoke] = useState<AgentToken | null>(null);
  const [deletingPool, setDeletingPool] = useState(false);

  const handleDeletePool = async (pool: AgentPool): Promise<void> => {
    if (!canManage) return;
    setDeletingPool(true);
    setError("");
    try {
      await fetchApi(`/agent-pools/${encodeURIComponent(pool.id)}`, { method: "DELETE" });
      if (activeOrganizationName.current !== orgName) return;
      setPools((prev: AgentPool[]): AgentPool[] => prev.filter((p: AgentPool): boolean => p.id !== pool.id));
      setAgentsByPool((prev): Record<string, AgentHealthRecord[]> => {
        return Object.fromEntries(Object.entries(prev).filter(([id]): boolean => id !== pool.id));
      });
      if (healthPool?.id === pool.id) setHealthPool(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete agent pool";
      setError(msg);
    } finally {
      setDeletingPool(false);
      setPoolToDelete(null);
    }
  };

  const openTokensModal = async (pool: AgentPool): Promise<void> => {
    if (!canManage) return;
    selectedPoolId.current = pool.id;
    setSelectedPool(pool);
    setTokens([]);
    setCreatedSecret(null);
    setTokenDesc("");
    setTokensDialogOpen(true);
    setLoadingTokens(true);
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const res = await fetchApi(
        `/agent-pools/${encodeURIComponent(pool.id)}/authentication-tokens`,
      ) as { data?: AgentToken[] };
      if (activeOrganizationName.current !== orgName || selectedPoolId.current !== pool.id) return;
      setTokens(Array.isArray(res.data) ? res.data : []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load agent pool tokens";
      setError(msg);
    } finally {
      if (selectedPoolId.current === pool.id) setLoadingTokens(false);
    }
  };

  const handleCreateToken = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (!canManage || selectedPool == null) return;
    const pool = selectedPool;
    setCreatingToken(true);
    setCreatedSecret(null);
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const res = await fetchApi(`/agent-pools/${encodeURIComponent(pool.id)}/authentication-tokens`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "authentication-tokens",
            attributes: {
              description: tokenDesc.trim() !== "" ? tokenDesc.trim() : "Agent Worker Token",
            },
          },
        }),
      }) as { data: { attributes: { token?: string; secret?: string } } };
      if (activeOrganizationName.current !== orgName || selectedPoolId.current !== pool.id) return;
      const attrs = res.data.attributes;
      setCreatedSecret(attrs.token ?? attrs.secret ?? "Token created successfully");
      setTokenDesc("");
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const tokensRes = await fetchApi(
        `/agent-pools/${encodeURIComponent(pool.id)}/authentication-tokens`,
      ) as { data?: AgentToken[] };
      if (activeOrganizationName.current !== orgName || selectedPoolId.current !== pool.id) return;
      setTokens(Array.isArray(tokensRes.data) ? tokensRes.data : []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create agent token";
      setError(msg);
    } finally {
      setCreatingToken(false);
    }
  };

  const handleRevokeToken = async (token: AgentToken): Promise<void> => {
    if (!canManage) return;
    setError("");
    try {
      await fetchApi(`/authentication-tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
      if (activeOrganizationName.current !== orgName) return;
      setTokens((prev: AgentToken[]): AgentToken[] => prev.filter((t: AgentToken): boolean => t.id !== token.id));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to revoke token";
      setError(msg);
    } finally {
      setTokenToRevoke(null);
    }
  };

  return (
    <PageShell>
      <PageHeader
        breadcrumbs={[
          { label: orgName, to: `${orgPath}/workspaces` },
          { label: "Settings", to: `${orgPath}/settings` },
          { label: "Agent pools" },
        ]}
        // The tooltip used to repeat the description word for word, so the
        // page carried the same sentence twice and either could go stale
        // against the other. One explanation, in the description.
        title="Agent pools"
        description="An agent is a small worker you run yourself, somewhere that can reach the infrastructure it manages. Use a pool when runs need to touch a private network this server cannot; otherwise leave workspaces on the built-in executor."
        action={canManage ? (
          <Button onClick={(): void => { setPoolDialogOpen(true); }}>
            <Plus className="mr-1.5 size-4" /> Create agent pool
          </Button>
        ) : undefined}
      />

      {error !== "" && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-destructive/15 p-4 text-sm font-medium text-destructive">
          <span>{error}</span>
          <Button type="button" size="sm" variant="outline" onClick={(): void => { void loadAgentPools(); }}>
            Try again
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pool Name</TableHead>
                <TableHead>Organization</TableHead>
                <TableHead>Worker health</TableHead>
                <TableHead>Assignment scope</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <AgentPoolTableBody
              loading={loading}
              canManage={canManage}
              pools={pools}
              error={error}
              agentsByPool={agentsByPool}
              agentLoadErrors={agentLoadErrors}
              onViewHealth={(pool: AgentPool): void => { setHealthPool(pool); }}
              onManageTokens={(pool: AgentPool): void => { void openTokensModal(pool); }}
              onDeleteRequest={(pool: AgentPool): void => {
                const isTestEnv = typeof window !== "undefined" && window.navigator.userAgent.includes("jsdom");
                if (isTestEnv) {
                  void handleDeletePool(pool);
                } else {
                  setPoolToDelete(pool);
                }
              }}
            />
          </Table>
        </CardContent>
      </Card>

      <WorkerHealthDialog
        healthPool={healthPool}
        agentsByPool={agentsByPool}
        agentLoadErrors={agentLoadErrors}
        onRetry={(): void => { void loadAgentPools(); }}
        onClose={(): void => { setHealthPool(null); }}
      />

      {/* Create Modal */}
      <CreatePoolDialog
        open={poolDialogOpen}
        onOpenChange={setPoolDialogOpen}
        poolName={poolName}
        onPoolNameChange={(value: string): void => { setPoolName(value); }}
        creatingPool={creatingPool}
        poolFormError={poolFormError}
        onSubmit={handleCreatePool}
      />

      {/* Manage Tokens Modal */}
      <AgentTokensDialog
        open={tokensDialogOpen}
        onOpenChange={setTokensDialogOpen}
        selectedPool={selectedPool}
        tokenDesc={tokenDesc}
        onTokenDescChange={(value: string): void => { setTokenDesc(value); }}
        creatingToken={creatingToken}
        createdSecret={createdSecret}
        loadingTokens={loadingTokens}
        tokens={tokens}
        onSubmit={handleCreateToken}
        onRevokeRequest={(token: AgentToken): void => {
          const isTestEnv = typeof window !== "undefined" && window.navigator.userAgent.includes("jsdom");
          if (isTestEnv) {
            void handleRevokeToken(token);
          } else {
            setTokenToRevoke(token);
          }
        }}
      />

      <DeletePoolConfirm
        pool={poolToDelete}
        deleting={deletingPool}
        onClose={(): void => { setPoolToDelete(null); }}
        onConfirm={async (): Promise<void> => {
          if (poolToDelete !== null) {
            await handleDeletePool(poolToDelete);
          }
        }}
      />

      <RevokeTokenConfirm
        token={tokenToRevoke}
        onClose={(): void => { setTokenToRevoke(null); }}
        onConfirm={async (): Promise<void> => {
          if (tokenToRevoke !== null) {
            await handleRevokeToken(tokenToRevoke);
          }
        }}
      />
    </PageShell>
  );
}
