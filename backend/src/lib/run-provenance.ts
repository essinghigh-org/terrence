import { createHash } from "node:crypto";
import { encryptSecret } from "./secrets";
import { executionSetting } from "./runtime-config";
import { runSandboxRequired, runNetPolicy } from "./sandbox";

export const RUN_PROVENANCE_SCHEMA_VERSION = 1;

export type PublicRunProvenance = Readonly<{
  schemaVersion: number;
  runId: string;
  createdAt: string;
  configuration: Readonly<{
    versionId: string | null;
    digest: string;
    source: string | null;
    commitSha: string | null;
    commitUrl: string | null;
    branch: string | null;
  }>;
  engine: Readonly<{
    binary: string;
    version: string | null;
    digest: string | null;
  }>;
  workspace: Readonly<{
    id: string;
    workingDirectory: string | null;
    executionMode: string;
  }>;
  inputState: Readonly<{ id: string | null; digest: string | null }>;
  variables: readonly Readonly<{
    key: string;
    category: string;
    source: string;
    variableSetId: string | null;
    sensitive: boolean;
  }>[];
  policy: Readonly<{ source: string; version: string | null }>;
  runTasks: Readonly<{ stages: readonly string[] }>;
  executionTarget: Readonly<{ mode: string; agentPoolId: string | null }>;
  sandbox: Readonly<{ required: boolean; networkPolicy: string; executor: string }>;
  rerun?: Readonly<{ mode: "original" | "current"; sourceRunId: string; changedSinceSource: readonly string[] }>;
}>;

type EffectiveVariableInput = Readonly<{
  source: "workspace" | "varset";
  key: string;
  category: string | null;
  sensitive: boolean | null;
  variableSetId?: string;
}>;

type RunVariableInput = Readonly<{
  key: string;
  category?: string;
  sensitive?: boolean;
  value: string;
  valueEncrypted?: string;
}>;

export type CapsuleInput = Readonly<{
  runId: string;
  createdAt: number;
  configurationVersionId: string | null;
  configurationSource: string | null;
  configurationIngress: Readonly<Record<string, unknown>> | null;
  configurationDigest: string;
  engine: string;
  engineVersion: string | null;
  workspaceId: string;
  workingDirectory: string | null;
  executionMode: string;
  agentPoolId: string | null;
  inputStateId: string | null;
  inputStateDigest: string | null;
  runVariables: readonly RunVariableInput[];
  effectiveVariables: readonly EffectiveVariableInput[];
  effectiveExecutionVariables: readonly RunVariableInput[];
}>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().flatMap((key): [string, unknown][] =>
      record[key] === undefined ? [] : [[key, canonicalize(record[key])]],
    ));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function ingressString(ingress: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const value = ingress?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Build an immutable public manifest and encrypted execution envelope. */
export async function buildRunProvenanceCapsule(input: CapsuleInput): Promise<Readonly<{
  publicManifest: PublicRunProvenance;
  manifestSha256: string;
  executionMaterial: string;
}>> {
  const ingress = input.configurationIngress;
  const variables = input.effectiveVariables
    .map((variable): PublicRunProvenance["variables"][number] => ({
      key: variable.key,
      category: variable.category ?? "terraform",
      source: variable.source === "varset" ? "variable-set" : "workspace",
      variableSetId: variable.variableSetId ?? null,
      sensitive: variable.sensitive === true,
    }))
    .concat(input.runVariables.map((variable): PublicRunProvenance["variables"][number] => ({
      key: variable.key,
      category: variable.category ?? "terraform",
      source: "run",
      variableSetId: null,
      sensitive: variable.sensitive === true,
    })))
    .sort((left, right): number => `${left.category}:${left.key}:${left.source}`.localeCompare(`${right.category}:${right.key}:${right.source}`));
  const publicManifest: PublicRunProvenance = {
    schemaVersion: RUN_PROVENANCE_SCHEMA_VERSION,
    runId: input.runId,
    createdAt: new Date(input.createdAt).toISOString(),
    configuration: {
      versionId: input.configurationVersionId,
      digest: input.configurationDigest,
      source: input.configurationSource,
      commitSha: ingressString(ingress, "commitSha"),
      commitUrl: ingressString(ingress, "commitUrl"),
      branch: ingressString(ingress, "branch"),
    },
    engine: { binary: input.engine, version: input.engineVersion, digest: null },
    workspace: { id: input.workspaceId, workingDirectory: input.workingDirectory, executionMode: input.executionMode },
    inputState: { id: input.inputStateId, digest: input.inputStateDigest },
    variables,
    policy: { source: "workspace-at-run-creation", version: null },
    runTasks: { stages: [] },
    executionTarget: { mode: input.executionMode, agentPoolId: input.agentPoolId },
    sandbox: {
      required: runSandboxRequired(),
      networkPolicy: runNetPolicy(),
      executor: executionSetting("TERRENCE_EXECUTOR_BACKEND"),
    },
  };
  const canonical = canonicalJson(publicManifest);
  const executionMaterial = await encryptSecret(canonicalJson({
    schemaVersion: RUN_PROVENANCE_SCHEMA_VERSION,
    variables: input.runVariables,
    effectiveVariables: input.effectiveExecutionVariables,
  }));
  return { publicManifest, manifestSha256: sha256Hex(canonical), executionMaterial };
}
