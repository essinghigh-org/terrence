import { resolve } from "node:path";
import type { configurationVersions, runs, workspaces } from "../db/schema";
import { availableVersions, resolveLatestVersion, validateVersion } from "../binaryManager";
import { mintRunToken } from "./run-token";
import { executionVariables } from "../worker";
import { signedApiURL, type DeepReadonly } from "../lib/utils";
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
  const configured = process.env.PUBLIC_URL?.trim();
  if (configured) {
    let parsed: URL;
    try {
      parsed = new URL(configured);
    } catch {
      throw new Error("PUBLIC_URL must be a valid http(s) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("PUBLIC_URL must use http or https");
    }
    return parsed.origin;
  }
  // A Host header is attacker-controlled. Only use a loopback host for local
  // development/test; deployed instances must configure their public origin.
  if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") {
    const host = request.headers.get("host") ?? "localhost";
    if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)) return `http://${host}`;
    return "http://localhost";
  }
  throw new Error("PUBLIC_URL must be configured for agent artifact URLs");
}

// --- Terraform release info (upstream URL + sha256, cached) -----------------

const releaseInfoCache = new Map<string, { url: string; checksum: string; at: number }>();
const RELEASE_INFO_TTL_MS = 60 * 60 * 1000;

/** Resolve a terraform version constraint to an exact release URL + sha256. */
export async function terraformReleaseInfo(
  versionInput: string,
  architecture = "amd64",
): Promise<{ version: string; url: string; checksum: string } | null> {
  const constraint = versionInput === "" || versionInput === null ? "latest" : versionInput;
  const version = await resolveTerraformVersion(constraint);
  if (version === null) return null;
  const normalizedArchitecture = architecture.toLowerCase() === "aarch64" || architecture.toLowerCase() === "arm64" ? "arm64" : "amd64";
  const cacheKey = `${version}:${normalizedArchitecture}`;
  const cached = releaseInfoCache.get(cacheKey);
  if (cached !== undefined && Date.now() - cached.at < RELEASE_INFO_TTL_MS) {
    return { version, url: cached.url, checksum: cached.checksum };
  }
  const zipName = `terraform_${version}_linux_${normalizedArchitecture}.zip`;
  const url = `https://releases.hashicorp.com/terraform/${version}/${zipName}`;
  try {
    const sums = await fetch(
      `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_SHA256SUMS`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!sums.ok) return null;
    const text = await sums.text();
    const line = text.split("\n").find((l: string): boolean => l.includes(zipName));
    const checksum = line?.split(/\s+/)[0];
    if (checksum === undefined || !/^[0-9a-f]{64}$/.test(checksum)) return null;
    releaseInfoCache.set(cacheKey, { url, checksum, at: Date.now() });
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

function parseVersionParts(version: string): number[] {
  return version.replace(/^v/, "").split(".").map((n: string): number => Number.parseInt(n, 10) || 0);
}

function compareVersionParts(parts: readonly number[], target: readonly number[]): number {
  for (let i = 0; i < Math.max(parts.length, target.length); i += 1) {
    const diff = (parts[i] ?? 0) - (target[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function satisfiesOperator(cmp: number, op: string, parts: readonly number[], target: readonly number[]): boolean {
  if (op === ">=") return cmp >= 0;
  if (op === "<=") return cmp <= 0;
  if (op === ">") return cmp > 0;
  if (op === "<") return cmp < 0;
  if (op === "!=") return cmp !== 0;
  if (op === "==") return cmp === 0;
  if (op === "~>") {
    if (cmp < 0 || parts[0] !== target[0]) return false;
    if (target.length >= 3 && (parts[1] ?? 0) !== (target[1] ?? 0)) return false;
    return true;
  }
  return false;
}

function satisfiesSingleClause(parts: readonly number[], clause: string): boolean {
  const trimmed = clause.trim();
  const match = /^(>=|<=|>|<|!=|~>|==)?\s*(.+)$/.exec(trimmed);
  if (match === null) return false;
  const op = match[1] ?? "==";
  const target = parseVersionParts(match[2] ?? "0");
  const cmp = compareVersionParts(parts, target);
  return satisfiesOperator(cmp, op, parts, target);
}

function satisfiesConstraint(version: string, constraint: string): boolean {
  const parts = parseVersionParts(version);
  for (const clause of constraint.split(",")) {
    if (!satisfiesSingleClause(parts, clause)) return false;
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
  terraformInfo: Readonly<{ version: string; url: string; checksum: string }>,
  terraformVariables: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string>>,
): Promise<Record<string, unknown>> {
  const { job, run, workspace, organizationName } = details;
  const phase = job.phase;
  const jobPath = `/api/agent/jobs/${job.id}`;
  // Artifact URLs are bearerless by design in the modern agent protocol, so
  // the job id must not be the only credential. Bind each URL to its path and
  // expiry with the same installation secret used by other hosted artifacts.
  // A wildcard method is intentional: the protocol reuses filesystem/log URLs
  // for both reads and writes, while the path remains strictly job-scoped.
  const artifactUrl = (suffix: string): string => signedApiURL({ url: baseUrl }, `${jobPath}${suffix}`, "*");
  const configurationUrl = artifactUrl("/configuration-version");
  const isDestroy = run.isDestroy === true;

  const data: Record<string, unknown> = {
    organization_name: organizationName,
    workspace_name: workspace.name,
    operation: phase,
    plan_id: run.id,
    run_id: run.id,
    // The binary the agent must execute for this job. tfc-agent ignores it
    // and always runs terraform; terrence-agent uses it to pick tofu.
    iac_binary: job.iacBinary,
    working_directory: workspace.workingDirectory ?? "",
    parallelism: 10,
    configuration_version_url: configurationUrl,
    filesystem_url: artifactUrl("/filesystem"),
    terraform_url: terraformInfo.url,
    terraform_checksum: terraformInfo.checksum,
    terraform_log_url: artifactUrl("/log"),
    json_provider_schemas_url: artifactUrl("/provider-schemas"),
    json_plan_url: artifactUrl("/plan-json"),
    json_redacted_plan_url: artifactUrl("/plan-json-redacted"),
    sanitized_plan_url: artifactUrl("/plan-json-sanitized"),
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
    parallelism: 10,
    destroy: isDestroy,
    refresh_only: run.refreshOnly === true,
    target_addrs: run.targetAddrs ?? [],
    replace_addrs: run.replaceAddrs ?? [],
    api_address: baseUrl,
    tfvars: {},
  };

  let container: Record<string, unknown>;
  if (phase === "plan") {
    container = {
      ...commonContainer,
      plan_mode: "plan",
      source_directory: "",
      raw_plan_url: artifactUrl("/raw-plan"),
      description: run.message ?? "",
      api_address: baseUrl,
      access_token: runToken,
      organization_id: workspace.orgId,
      agent_host_url: baseUrl,
      source_bundle_download_url: configurationUrl,
      plan_description_url: artifactUrl("/plan-description"),
      upload_url: artifactUrl("/upload"),
      outcome_upload_urls: {
        plan: artifactUrl("/outcomes/plan"),
        apply: artifactUrl("/outcomes/apply"),
      },
    };
  } else {
    container = {
      ...commonContainer,
      destroy: isDestroy,
      refresh_only: run.refreshOnly === true,
      target_addrs: run.targetAddrs ?? [],
      replace_addrs: run.replaceAddrs ?? [],
      plan_file: artifactUrl("/raw-plan"),
      apply_description_url: artifactUrl("/apply-description"),
      state_description_url: artifactUrl("/state-description"),
      outcome_upload_urls: {
        apply: artifactUrl("/outcomes/apply"),
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
