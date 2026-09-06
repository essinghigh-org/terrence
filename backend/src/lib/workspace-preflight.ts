/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, desc, eq } from "drizzle-orm";

import { db } from "../db";
import { agents, configurationVersions, githubAppInstallations, oauthClients, oauthTokens, organizations } from "../db/schema";
import type { workspaces } from "../db/schema";
import { storageDir } from "../db/driver";
import { effectiveWorkspaceVariables, type EffectiveVariable } from "./effective-variables";
import { configuredHeartbeatTimeoutMs } from "./agent-jobs";
import { installedBinaryVersions, knownAvailableVersions, preflightBinaryAvailability, validateVersion } from "../binaryManager";
import { archiveContainsWorkingDir, listArchiveMembers, readBoundedProcessOutput } from "../workspace";
import { scanTerraformModuleVariablesWithDiagnostics } from "./terraform-variables";
import { inspectStorageHeadroom, storageDegradedReason } from "./storage-health";
import { probeLandlockAbi, runNetPolicy, runSandboxRequired } from "./sandbox";
import { envFlag } from "./env";
import { inspectWorkspaceIdentityConfiguration } from "./workload-identity";

export type PreflightAssessmentStatus = "ready" | "blocked" | "unknown";
export type PreflightCheckStatus = "configured" | "reachable" | "usable" | "unknown" | "failed";

export type WorkspacePreflightCheck = Readonly<{
  id: string;
  status: PreflightCheckStatus;
  required: boolean;
  advisory: boolean;
  detail: string;
  fix?: string;
  "execution-context": "control-plane" | "worker" | "agent" | "client";
}>;

export type WorkspacePreflightAssessment = Readonly<{
  id: string;
  type: "preflight-assessments";
  status: PreflightAssessmentStatus;
  "checked-at": string;
  "expires-at": string;
  source: "control-plane";
  generation: string;
  cached: boolean;
  "execution-context": string;
  "can-run-anyway": boolean;
  checks: readonly WorkspacePreflightCheck[];
}>;

export type WorkspacePreflightOptions = Readonly<{
  probes?: readonly string[];
  now?: number;
}>;

const CACHE_TTL_MS = 15_000;
const CACHE_LIMIT = 256;
const ARCHIVE_SOURCE_LIMIT = 4 * 1024 * 1024;
const ARCHIVE_FILE_LIMIT = 64;
const ARCHIVE_FILE_TIMEOUT_MS = 5_000;
const preflightCache = new Map<string, Readonly<{ expiresAtMs: number; generation: string; assessment: WorkspacePreflightAssessment }>>();

type WorkspaceRow = typeof workspaces.$inferSelect;
type ConfigurationRow = typeof configurationVersions.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

type Snapshot = Readonly<{
  workspace: WorkspaceRow;
  organization: typeof organizations.$inferSelect | undefined;
  configuration: ConfigurationRow | undefined;
  archiveMembers: ReadonlySet<string> | null;
  archiveFingerprint: Readonly<{ size: number; mtimeMs: number }> | null;
  variables: readonly EffectiveVariable[];
  agents: readonly AgentRow[];
  vcsConfigured: boolean | null;
  now: number;
}>;

function hashValue(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value) ?? "").digest("hex");
}

function check(
  id: string,
  status: PreflightCheckStatus,
  required: boolean,
  detail: string,
  fix: string | undefined,
  executionContext: WorkspacePreflightCheck["execution-context"],
  advisory = false,
): WorkspacePreflightCheck {
  return {
    id,
    status,
    required,
    advisory,
    detail,
    ...(fix === undefined ? {} : { fix }),
    "execution-context": executionContext,
  };
}

function normalizedWorkingDirectory(value: string | null): string {
  return (value ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function requestedEngine(workspace: WorkspaceRow, organization: typeof organizations.$inferSelect | undefined): { tool: string; version: string } {
  return {
    tool: workspace.iacBinary ?? organization?.defaultIacBinary ?? "terraform",
    version: workspace.terraformVersion ?? organization?.defaultTerraformVersion ?? "latest",
  };
}

async function archiveVariableScan(
  archivePath: string,
  members: ReadonlySet<string>,
): Promise<Readonly<{ variables: readonly Readonly<{ name: string; hasDefault: boolean }>[]; skipped: number; failed: boolean }>> {
  const terraformMembers = [...members]
    .filter((member): boolean => /(?:^|\/)[^/]+\.tf(?:\.json)?$/.test(member) && !member.endsWith("/"))
    .sort()
    .slice(0, ARCHIVE_FILE_LIMIT);
  if (terraformMembers.length === 0) return { variables: [], skipped: 0, failed: false };
  const directory = await mkdtemp(join(tmpdir(), "terrence-preflight-"));
  let bytes = 0;
  try {
    for (const [index, member] of terraformMembers.entries()) {
      const process = Bun.spawn(["tar", "-xOzf", archivePath, "--", member], { stdout: "pipe", stderr: "ignore" });
      const source = await readBoundedProcessOutput(process, Math.max(1, ARCHIVE_SOURCE_LIMIT - bytes), ARCHIVE_FILE_TIMEOUT_MS);
      if (source === null) return { variables: [], skipped: 0, failed: true };
      bytes += new TextEncoder().encode(source).byteLength;
      const extension = member.endsWith(".tf.json") ? ".tf.json" : ".tf";
      await writeFile(join(directory, `source-${index}${extension}`), source, { mode: 0o600 });
    }
    const result = await scanTerraformModuleVariablesWithDiagnostics(directory);
    return {
      variables: result.variables.map((variable) => ({ name: variable.name, hasDefault: variable.hasDefault })),
      skipped: result.skipped.length,
      failed: false,
    };
  } catch {
    return { variables: [], skipped: 0, failed: true };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function vcsConfiguration(workspace: WorkspaceRow): Promise<boolean | null> {
  const repo = workspace.vcsRepo;
  if (repo === null || repo === undefined) return null;
  const tokenId = typeof repo.oauthTokenId === "string" ? repo.oauthTokenId : null;
  const installationId = typeof repo.githubAppInstallationId === "string" ? repo.githubAppInstallationId : null;
  if (tokenId === null && installationId === null) return false;
  const [token, installation] = await Promise.all([
    tokenId === null ? Promise.resolve(undefined) : db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, tokenId) }),
    installationId === null ? Promise.resolve(undefined) : db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.id, installationId) }),
  ]);
  if (token !== undefined) {
    const client = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, token.oauthClientId) });
    if (client?.orgId === workspace.orgId) return true;
  }
  return installation?.orgId === workspace.orgId;
}

async function loadSnapshot(workspace: WorkspaceRow, now: number): Promise<Snapshot> {
  const [organization, configuration, variables, vcsConfigured] = await Promise.all([
    db.query.organizations.findFirst({ where: eq(organizations.id, workspace.orgId) }),
    db.query.configurationVersions.findFirst({
      where: and(eq(configurationVersions.workspaceId, workspace.id), eq(configurationVersions.status, "uploaded")),
      orderBy: [desc(configurationVersions.createdAt)],
    }),
    effectiveWorkspaceVariables(workspace.id, workspace.orgId, workspace.projectId),
    vcsConfiguration(workspace),
  ]);
  const archiveMembers = configuration?.archivePath === null || configuration?.archivePath === undefined
    ? null
    : await listArchiveMembers(configuration.archivePath);
  let archiveFingerprint: Readonly<{ size: number; mtimeMs: number }> | null = null;
  if (configuration?.archivePath !== null && configuration?.archivePath !== undefined) {
    try {
      const archiveStat = await stat(configuration.archivePath);
      archiveFingerprint = { size: archiveStat.size, mtimeMs: archiveStat.mtimeMs };
    } catch {
      archiveFingerprint = null;
    }
  }
  const poolAgents = workspace.agentPoolId === null
    ? []
    : await db.query.agents.findMany({ where: eq(agents.agentPoolId, workspace.agentPoolId) });
  return { workspace, organization, configuration, archiveMembers, archiveFingerprint, variables, agents: poolAgents, vcsConfigured, now };
}

function generationFor(snapshot: Snapshot): string {
  const { workspace, organization, configuration, archiveMembers, archiveFingerprint, variables, agents: poolAgents, vcsConfigured } = snapshot;
  return hashValue({
    workspace: {
      id: workspace.id, orgId: workspace.orgId, projectId: workspace.projectId, iacBinary: workspace.iacBinary,
      terraformVersion: workspace.terraformVersion, workingDirectory: workspace.workingDirectory,
      executionMode: workspace.executionMode, agentPoolId: workspace.agentPoolId, vcsRepo: workspace.vcsRepo,
    },
    organization: organization === undefined ? null : {
      defaultIacBinary: organization.defaultIacBinary, defaultTerraformVersion: organization.defaultTerraformVersion,
    },
    configuration: configuration === undefined ? null : {
      id: configuration.id, status: configuration.status, archivePath: configuration.archivePath, createdAt: configuration.createdAt,
    },
    archiveMembers: archiveMembers === null ? null : [...archiveMembers].sort(),
    archiveFingerprint,
    variables: variables.map((entry) => ({ source: entry.source, key: entry.variable.key, category: entry.variable.category, sensitive: entry.variable.sensitive, value: hashValue(entry.variable.valueEncrypted ?? entry.variable.value) })),
    agents: poolAgents.map((agent) => ({ id: agent.id, status: agent.status, iacBinaries: agent.iacBinaries, lastPingAt: agent.lastPingAt })).sort((a, b) => a.id.localeCompare(b.id)),
    vcsConfigured,
  });
}

async function configurationCheck(snapshot: Snapshot): Promise<WorkspacePreflightCheck> {
  const { workspace, configuration, archiveMembers } = snapshot;
  const context = workspace.executionMode === "local" ? "client" : "control-plane";
  if (configuration === undefined || configuration.archivePath === null) {
    if (workspace.executionMode === "local") return check("configuration", "unknown", false, "Local execution supplies configuration from the client context.", "Run the preflight from the CLI or upload a configuration version.", context, true);
    return check("configuration", "failed", true, "No uploaded configuration version is available.", "Upload a configuration version for this workspace.", context);
  }
  if (!(await Bun.file(configuration.archivePath).exists())) {
    return check("configuration", "failed", true, "The latest configuration archive is unavailable.", "Upload a new configuration version.", context);
  }
  if (archiveMembers === null) return check("configuration", "failed", true, "The configuration archive could not be read.", "Upload a valid configuration archive.", context);
  const workingDirectory = normalizedWorkingDirectory(workspace.workingDirectory);
  if (workingDirectory !== "" && !archiveContainsWorkingDir(archiveMembers, workingDirectory)) {
    return check("configuration", "failed", true, "The configured working directory is not present in the archive.", "Set the working directory to a directory in the uploaded configuration or upload the matching source.", context);
  }
  return check("configuration", "usable", true, "The latest configuration archive is available and its working directory is present.", undefined, context);
}

async function inputCheck(snapshot: Snapshot): Promise<WorkspacePreflightCheck> {
  const { workspace, configuration, archiveMembers, variables } = snapshot;
  if (configuration?.archivePath === null || configuration?.archivePath === undefined || archiveMembers === null) {
    return check("inputs", "unknown", false, "Input completeness will be checked in the execution context.", "Upload configuration or run the preflight from the client context.", workspace.executionMode === "local" ? "client" : "worker", true);
  }
  const scan = await archiveVariableScan(configuration.archivePath, archiveMembers);
  if (scan.failed) return check("inputs", "unknown", true, "Terraform variable declarations could not be inspected safely.", "Run a plan to let the selected engine validate the configuration inputs.", "control-plane");
  const provided = new Set(variables.filter((entry) => entry.variable.category === "terraform").map((entry) => entry.variable.key));
  const missing = scan.variables.filter((variable) => !variable.hasDefault && !provided.has(variable.name)).map((variable) => variable.name);
  if (missing.length > 0) {
    return check("inputs", "failed", true, `Required Terraform inputs are missing (${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ", …" : ""}).`, "Add the missing workspace or variable-set values before starting the run.", "control-plane");
  }
  if (scan.skipped > 0) return check("inputs", "unknown", false, "Some Terraform variable declarations could not be parsed by the advisory scanner.", "Run a plan to let the selected engine validate the configuration inputs.", "control-plane", true);
  return check("inputs", "usable", true, "All scanned required Terraform inputs have values or defaults.", undefined, "control-plane");
}

async function engineCheck(snapshot: Snapshot): Promise<WorkspacePreflightCheck> {
  const { workspace, organization } = snapshot;
  const { tool, version } = requestedEngine(workspace, organization);
  if (tool !== "terraform" && tool !== "tofu") return check("engine", "failed", true, "The workspace selects an unsupported IaC engine.", "Choose terraform or tofu in workspace settings.", "control-plane");
  if (!validateVersion(version)) return check("engine", "failed", true, "The configured IaC version is invalid.", "Choose a supported exact version, latest, or version constraint.", "control-plane");
  if (workspace.executionMode === "local") return check("engine", "unknown", false, "The selected engine will be resolved in the client execution context.", "Run the preflight from the client context to verify the installed engine.", "client", true);
  if (workspace.executionMode === "agent") return check("engine", "unknown", false, "The selected engine version will be resolved by the matching agent.", "Run the preflight in the agent context to verify the installed engine version.", "agent", true);
  const availability = await preflightBinaryAvailability(tool, version);
  if (!availability.ok) return check("engine", "failed", true, availability.detail, "Install or select a supported version of the configured IaC engine.", "worker");
  const installed = await installedBinaryVersions(tool);
  const exact = /^v?([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?)$/.exec(version.trim())?.[1];
  if (exact !== undefined && installed.includes(exact)) return check("engine", "usable", true, `${tool} ${exact} is installed and ready.`, undefined, "worker");
  if (knownAvailableVersions(tool).length > 0 || version.trim() === "latest" || version.includes(">") || version.includes("<") || version.includes("=")) {
    return check("engine", "reachable", true, `${tool} can be resolved when the run starts; binary resolution remains in the worker execution context.`, undefined, "worker", true);
  }
  return check("engine", "unknown", true, `No local ${tool} binary or release metadata is available to confirm this version.`, "Run the preflight where the worker can resolve the selected engine or install it in the binary cache.", "worker");
}

function targetCheck(snapshot: Snapshot): WorkspacePreflightCheck {
  const { workspace, agents: poolAgents, now } = snapshot;
  if (workspace.executionMode === "local") return check("execution-target", "configured", true, "The run will execute in the client context.", undefined, "client");
  if (workspace.executionMode === "remote") {
    if (envFlag("TERRENCE_DISABLE_WORKER")) return check("execution-target", "failed", true, "The Terrence worker is disabled.", "Enable the worker before starting a remote run.", "worker");
    return check("execution-target", "usable", true, "A remote worker target is configured.", undefined, "worker");
  }
  if (workspace.executionMode !== "agent") return check("execution-target", "failed", true, "The workspace execution mode is unsupported.", "Choose local, remote, or agent execution.", "control-plane");
  if (workspace.agentPoolId === null) return check("execution-target", "failed", true, "No agent pool is attached to this workspace.", "Attach an agent pool before starting an agent run.", "agent");
  const timeout = configuredHeartbeatTimeoutMs();
  const live = poolAgents.filter((agent) => agent.lastPingAt !== null && now - agent.lastPingAt <= timeout && !["exited", "errored", "unknown"].includes(agent.status));
  const { tool } = requestedEngine(workspace, snapshot.organization);
  const matching = live.filter((agent) => Array.isArray(agent.iacBinaries) && agent.iacBinaries.includes(tool));
  if (matching.some((agent) => agent.status === "idle")) return check("execution-target", "usable", true, "An online idle agent supports the selected IaC engine.", undefined, "agent");
  if (matching.length > 0) return check("execution-target", "reachable", true, "A matching agent is online but currently busy; the run may wait in the queue.", undefined, "agent", true);
  if (live.length > 0) return check("execution-target", "failed", true, "Online agents do not advertise the selected IaC engine.", "Connect an agent with the selected engine or change the workspace engine.", "agent");
  return check("execution-target", "failed", true, "No healthy agent is currently available in the attached pool.", "Start an agent in the attached pool and retry the preflight.", "agent");
}

function healthCheck(): WorkspacePreflightCheck {
  const degraded = storageDegradedReason();
  if (degraded !== null) return check("health", "failed", true, `The control plane reports degraded storage: ${degraded}`, "Recover the Terrence storage volume before starting a run.", "control-plane");
  return check("health", "usable", true, "The control plane is responding and has no latched storage failure.", undefined, "control-plane");
}

function sandboxCheck(snapshot: Snapshot): WorkspacePreflightCheck {
  const { workspace } = snapshot;
  if (workspace.executionMode === "agent") return check("sandbox", "unknown", false, "Agent sandbox capability is verified when the agent claims the run.", "Run the preflight in the agent execution context to verify sandbox policy.", "agent", true);
  if (workspace.executionMode === "local") return check("sandbox", "unknown", false, "Local sandbox capability belongs to the client execution context.", "Run the preflight from the client context to verify sandbox policy.", "client", true);
  try {
    if (!runSandboxRequired()) return check("sandbox", "configured", false, "The deployment explicitly disables the run sandbox.", "Enable the run sandbox for isolated execution.", "worker", true);
    const abi = probeLandlockAbi();
    if (abi < 1) return check("sandbox", "failed", true, "The required Landlock sandbox is unavailable to the worker.", "Install the landlock runner and enable Landlock on the worker host.", "worker");
    if (runNetPolicy() === "deny" && abi < 4) return check("sandbox", "failed", true, "The worker requires network isolation but its Landlock ABI is too old.", "Upgrade the worker kernel or use a Landlock ABI that supports network rules.", "worker");
    return check("sandbox", "usable", true, `The worker sandbox is available (Landlock ABI ${abi}).`, undefined, "worker");
  } catch {
    return check("sandbox", "unknown", true, "Sandbox policy could not be verified by the control plane.", "Run the preflight in the worker execution context.", "worker");
  }
}

async function storageCheck(): Promise<WorkspacePreflightCheck> {
  const degraded = storageDegradedReason();
  if (degraded !== null) return check("storage", "failed", true, `Terrence storage is degraded: ${degraded}`, "Free storage and restart or recover the Terrence instance.", "control-plane");
  const headroom = await inspectStorageHeadroom(storageDir);
  if (headroom === null) return check("storage", "unknown", true, "Storage headroom could not be inspected.", "Check the storage volume from the worker execution context.", "control-plane");
  if (headroom.availableBytes < headroom.minimumBytes) return check("storage", "failed", true, "Terrence storage has insufficient free space for a run.", "Free space on the Terrence storage volume before starting the run.", "control-plane");
  return check("storage", "usable", true, "Terrence storage has enough free space for a run.", undefined, "control-plane");
}

function integrationChecks(snapshot: Snapshot): WorkspacePreflightCheck[] {
  const checks: WorkspacePreflightCheck[] = [];
  if (snapshot.vcsConfigured !== null) {
    checks.push(snapshot.vcsConfigured
      ? check("vcs-integration", "configured", true, "The configured VCS integration belongs to this organization.", undefined, "control-plane")
      : check("vcs-integration", "failed", true, "The configured VCS integration is missing or belongs to another organization.", "Reconnect the VCS integration for this organization.", "control-plane"));
  }
  const identity = inspectWorkspaceIdentityConfiguration(snapshot.variables.map((entry) => entry.variable.key));
  if (identity.configured) {
    checks.push(check("workload-identity", "configured", false, "Workload identity inputs are present; provider connectivity is deferred to the execution context.", "Run an identity probe in the worker or agent context to validate provider access.", snapshot.workspace.executionMode === "agent" ? "agent" : snapshot.workspace.executionMode === "local" ? "client" : "worker", true));
  }
  return checks;
}

function optionalProbeChecks(snapshot: Snapshot, probes: readonly string[] | undefined): WorkspacePreflightCheck[] {
  if (probes === undefined) return [];
  return [...new Set(probes)].filter((probe): boolean => probe === "connectivity" || probe === "identity").map((probe) => check(
    `probe-${probe}`,
    "unknown",
    false,
    `The ${probe} probe is deferred to the eventual ${snapshot.workspace.executionMode} execution context; the control plane made no outbound request.`,
    "Run the probe with the same worker, agent, or client context that will execute the run.",
    snapshot.workspace.executionMode === "agent" ? "agent" : snapshot.workspace.executionMode === "local" ? "client" : "worker",
    true,
  ));
}

function assessmentFromChecks(snapshot: Snapshot, generation: string, checks: readonly WorkspacePreflightCheck[], now: number, cached: boolean): WorkspacePreflightAssessment {
  const blocked = checks.some((item) => item.required && item.status === "failed");
  const uncertain = checks.some((item) => item.required && !item.advisory && item.status === "unknown");
  const advisoryUnknown = checks.some((item) => item.advisory && item.status === "unknown");
  return {
    id: `preflight-${snapshot.workspace.id}`,
    type: "preflight-assessments",
    status: blocked ? "blocked" : uncertain || advisoryUnknown ? "unknown" : "ready",
    "checked-at": new Date(now).toISOString(),
    "expires-at": new Date(now + CACHE_TTL_MS).toISOString(),
    source: "control-plane",
    generation,
    cached,
    "execution-context": snapshot.workspace.executionMode,
    "can-run-anyway": !blocked && !uncertain,
    checks,
  };
}

export function clearWorkspacePreflightCacheForTests(): void {
  preflightCache.clear();
}

export async function assessWorkspacePreflight(
  workspace: WorkspaceRow,
  options: WorkspacePreflightOptions = {},
): Promise<WorkspacePreflightAssessment> {
  const now = options.now ?? Date.now();
  const snapshot = await loadSnapshot(workspace, now);
  const generation = generationFor(snapshot);
  const cached = preflightCache.get(workspace.id);
  if (cached !== undefined && cached.expiresAtMs > now && cached.generation === generation && options.probes === undefined) {
    return { ...cached.assessment, cached: true };
  }
  const checks: WorkspacePreflightCheck[] = [
    healthCheck(),
    await configurationCheck(snapshot),
    await engineCheck(snapshot),
    await inputCheck(snapshot),
    targetCheck(snapshot),
    sandboxCheck(snapshot),
    await storageCheck(),
    ...integrationChecks(snapshot),
    ...optionalProbeChecks(snapshot, options.probes),
  ];
  const assessment = assessmentFromChecks(snapshot, generation, checks, now, false);
  preflightCache.delete(workspace.id);
  preflightCache.set(workspace.id, { expiresAtMs: now + CACHE_TTL_MS, generation, assessment });
  while (preflightCache.size > CACHE_LIMIT) {
    const oldest = preflightCache.keys().next().value;
    if (typeof oldest !== "string") break;
    preflightCache.delete(oldest);
  }
  return assessment;
}

export function preflightResource(assessment: WorkspacePreflightAssessment): Readonly<{ data: Readonly<{ id: string; type: string; attributes: Record<string, unknown> }> }> {
  return {
    data: {
      id: assessment.id,
      type: assessment.type,
      attributes: {
        status: assessment.status,
        "checked-at": assessment["checked-at"],
        "expires-at": assessment["expires-at"],
        source: assessment.source,
        generation: assessment.generation,
        cached: assessment.cached,
        "execution-context": assessment["execution-context"],
        "can-run-anyway": assessment["can-run-anyway"],
        checks: assessment.checks,
      },
    },
  };
}
