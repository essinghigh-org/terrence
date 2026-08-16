import { resolve } from "node:path";
import { configurationVersions, runs, workspaces } from "../db/schema";
import { availableVersions, resolveLatestVersion, validateVersion } from "../binaryManager";
import { mintRunToken } from "./run-token";
import { executionVariables } from "../worker";
import type { DeepReadonly } from "../lib/utils";
import type { AgentJob } from "./agent-jobs";

/**
 * Modern tfc-agent protocol (1.30+): job payload builder and artifact paths.
 *
 * The agent protocol surface was captured empirically against tfc-agent
 * 1.30.1 (2026-08): /api/agent/register, /api/agent/status,
 * /api/agent/jobs, plus per-job artifact URLs embedded in the job payload.
 * The agent follows the URLs verbatim and authenticates every call with the
 * pool's agent token, so Terrence can route all artifacts under
 * /api/agent/jobs/:job_id/*.
 */

const AGENT_FS_DIR = resolve(
  process.env.STORAGE_DIR ?? new URL("../../storage", import.meta.url).pathname,
  "agent-filesystems",
);

export function agentFilesystemPath(runId: string): string {
  return resolve(AGENT_FS_DIR, `${runId}.tar.gz`);
}

/** Public base URL for the job's absolute artifact URLs (caddy reverse proxy aware). */
export function agentApiBaseUrl(request: { readonly headers: { readonly get: (name: string) => string | null } }): string {
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "localhost";
  return `${proto}://${host}`;
}

// --- Terraform release info (upstream URL + sha256, cached) -----------------

const releaseInfoCache = new Map<string, { url: string; checksum: string; at: number }>();
const RELEASE_INFO_TTL_MS = 60 * 60 * 1000;

/** Resolve a terraform version constraint to an exact release URL + sha256. */
export async function terraformReleaseInfo(
  versionInput: string,
): Promise<{ version: string; url: string; checksum: string } | null> {
  const constraint = versionInput === "" || versionInput === null ? "latest" : versionInput;
  const version = await resolveTerraformVersion(constraint);
  if (version === null) return null;
  const cached = releaseInfoCache.get(version);
  if (cached !== undefined && Date.now() - cached.at < RELEASE_INFO_TTL_MS) {
    return { version, url: cached.url, checksum: cached.checksum };
  }
  const url = `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_linux_amd64.zip`;
  try {
    const sums = await fetch(
      `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_SHA256SUMS`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!sums.ok) return null;
    const text = await sums.text();
    const line = text.split("\n").find((l: string): boolean => l.includes("linux_amd64.zip"));
    const checksum = line?.split(/\s+/)[0];
    if (checksum === undefined || !/^[0-9a-f]{64}$/.test(checksum)) return null;
    releaseInfoCache.set(version, { url, checksum, at: Date.now() });
    return { version, url, checksum };
  } catch {
    return null;
  }
}

async function resolveTerraformVersion(constraint: string): Promise<string | null> {
  if (constraint === "latest") return resolveLatestVersion("terraform");
  if (validateVersion(constraint)) return constraint.replace(/^v/, "");
  // Constraint expression (>=, ~>, !=): pick the highest satisfying release.
  const releases = await availableVersions("terraform");
  if (releases.length === 0) return null;
  const candidates = releases
    .filter((v: string): boolean => satisfiesConstraint(v, constraint))
    .sort(compareVersions);
  return candidates.length > 0 ? candidates[candidates.length - 1] ?? null : null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n: string): number => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n: string): number => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function satisfiesConstraint(version: string, constraint: string): boolean {
  const v = version.replace(/^v/, "");
  const parts = v.split(".").map((n: string): number => Number.parseInt(n, 10) || 0);
  for (const clause of constraint.split(",")) {
    const trimmed = clause.trim();
    const match = trimmed.match(/^(>=|<=|>|<|!=|~>|==)?\s*(.+)$/);
    if (match === null) return false;
    const op = match[1] ?? "==";
    const target = (match[2] ?? "0").replace(/^v/, "").split(".").map((n: string): number => Number.parseInt(n, 10) || 0);
    // Numeric comparison for the parsed arrays (compareVersions takes strings).
    let cmp = 0;
    for (let i = 0; i < Math.max(parts.length, target.length); i += 1) {
      const diff = (parts[i] ?? 0) - (target[i] ?? 0);
      if (diff !== 0) {
        cmp = diff;
        break;
      }
    }
    if (op === ">=" && cmp < 0) return false;
    if (op === "<=" && cmp > 0) return false;
    if (op === ">" && cmp <= 0) return false;
    if (op === "<" && cmp >= 0) return false;
    if (op === "!=" && cmp === 0) return false;
    if (op === "~>" && (cmp < 0 || parts[0] !== target[0] || (target[1] !== undefined && (parts[1] ?? 0) !== target[1]))) return false;
    if (op === "==" && cmp !== 0) return false;
  }
  return true;
}

// --- Job payload ------------------------------------------------------------

export type AgentJobDetails = Readonly<{
  job: AgentJob;
  run: DeepReadonly<typeof runs.$inferSelect>;
  workspace: DeepReadonly<typeof workspaces.$inferSelect>;
  organizationName: string;
  configuration: (DeepReadonly<typeof configurationVersions.$inferSelect>) | null;
}>;

/** Mint a run token for the agent's cloud-protocol calls. */
export async function agentRunToken(runId: string, workspaceId: string, orgId: string): Promise<string> {
  return mintRunToken(runId, workspaceId, orgId);
}

export async function buildAgentJobPayload(
  details: AgentJobDetails,
  baseUrl: string,
  runToken: string,
  terraformInfo: { version: string; url: string; checksum: string },
  terraformVariables: Record<string, string>,
  environment: Record<string, string>,
): Promise<Record<string, unknown>> {
  const { job, run, workspace, organizationName } = details;
  const phase = job.phase;
  const jobPath = `/api/agent/jobs/${job.id}`;
  const configurationUrl = `${baseUrl}${jobPath}/configuration-version`;
  const isDestroy = run.isDestroy === true;

  const data: Record<string, unknown> = {
    organization_name: organizationName,
    workspace_name: workspace.name,
    operation: phase,
    plan_id: run.id,
    run_id: run.id,
    working_directory: workspace.workingDirectory ?? "",
    parallelism: 10,
    configuration_version_url: configurationUrl,
    filesystem_url: `${baseUrl}${jobPath}/filesystem`,
    terraform_url: terraformInfo.url,
    terraform_checksum: terraformInfo.checksum,
    terraform_log_url: `${baseUrl}${jobPath}/log`,
    json_provider_schemas_url: `${baseUrl}${jobPath}/provider-schemas`,
    json_plan_url: `${baseUrl}${jobPath}/plan-json`,
    json_redacted_plan_url: `${baseUrl}${jobPath}/plan-json-redacted`,
    sanitized_plan_url: `${baseUrl}${jobPath}/plan-json-sanitized`,
    token: runToken,
    timeout: "1h",
    // Process environment for the agent's terraform invocation (env-category
    // workspace variables, e.g. TFE_TOKEN). Verified against tfc-agent
    // 1.30.1: data.environment is a map applied to the run environment.
    environment,
  };

  const commonContainer: Record<string, unknown> = {
    current_operation: phase,
    terraform_version: terraformInfo.version,
    variables: terraformVariables,
    tfvars: {},
  };

  let container: Record<string, unknown>;
  if (phase === "plan") {
    container = {
      ...commonContainer,
      plan_mode: "plan",
      source_directory: "",
      raw_plan_url: `${baseUrl}${jobPath}/raw-plan`,
      description: run.message ?? "",
      api_address: baseUrl,
      access_token: runToken,
      organization_id: workspace.orgId,
      agent_host_url: baseUrl,
      source_bundle_download_url: configurationUrl,
      plan_description_url: `${baseUrl}${jobPath}/plan-description`,
      upload_url: `${baseUrl}${jobPath}/upload`,
      outcome_upload_urls: {
        plan: `${baseUrl}${jobPath}/outcomes/plan`,
        apply: `${baseUrl}${jobPath}/outcomes/apply`,
      },
    };
  } else {
    container = {
      ...commonContainer,
      destroy: isDestroy,
      refresh_only: run.refreshOnly === true,
      target_addrs: run.targetAddrs ?? [],
      replace_addrs: run.replaceAddrs ?? [],
      plan_file: `${baseUrl}${jobPath}/raw-plan`,
      apply_description_url: `${baseUrl}${jobPath}/apply-description`,
      state_description_url: `${baseUrl}${jobPath}/state-description`,
      outcome_upload_urls: {
        apply: `${baseUrl}${jobPath}/outcomes/apply`,
      },
    };
  }

  return { type: phase, job_id: job.id, data, [phase]: container };
}

/** Resolve env-category variables for the agent run's process environment. */
export async function agentEnvironment(
  workspaceId: string,
  orgId: string,
  projectId: string | null,
): Promise<Record<string, string>> {
  const variables = await executionVariables(workspaceId, orgId, projectId);
  const out: Record<string, string> = {};
  for (const variable of variables) {
    if (variable.category === "env") {
      out[variable.key] = variable.value;
    } else if (variable.category === "terraform") {
      // Terraform variables travel as TF_VAR_* environment variables
      // (verified against tfc-agent 1.30.1: the plan container's
      // `variables` key is not consumed; TF_VAR_ overrides are).
      out[`TF_VAR_${variable.key}`] = variable.value;
    }
  }
  return out;
}
