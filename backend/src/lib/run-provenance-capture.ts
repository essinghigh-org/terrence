import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { stateVersions } from "../db/schema";
import type { configurationVersions, runProvenanceCapsules, workspaces } from "../db/schema";
import { effectiveWorkspaceVariables, type EffectiveVariable } from "./effective-variables";
import { newResourceId } from "./resource-id";
import { buildRunProvenanceCapsule, canonicalJson, sha256Hex, type CapsuleInput } from "./run-provenance";
import { runVariablesForWrite } from "./run-variables";
import type { DeepReadonly } from "./types";

function configurationDigest(
  configurationVersion: DeepReadonly<typeof configurationVersions.$inferSelect> | undefined,
): string {
  return sha256Hex(
    canonicalJson({
      id: configurationVersion?.id ?? null,
      status: configurationVersion?.status ?? null,
      ingressAttributes: configurationVersion?.ingressAttributes ?? null,
      createdAt: configurationVersion?.createdAt ?? null,
    }),
  );
}

function manifestVariables(
  entries: readonly DeepReadonly<EffectiveVariable>[],
): Pick<CapsuleInput, "effectiveVariables" | "effectiveExecutionVariables"> {
  return {
    effectiveVariables: entries.map((entry) => ({
      source: entry.source,
      key: entry.variable.key,
      category: entry.variable.category,
      sensitive: entry.variable.sensitive,
      ...(entry.source === "varset" ? { variableSetId: entry.setId } : {}),
    })),
    effectiveExecutionVariables: entries.map((entry) => ({
      key: entry.variable.key,
      value: entry.variable.value,
      category: entry.variable.category ?? "terraform",
      sensitive: entry.variable.sensitive === true,
      ...(entry.variable.valueEncrypted === null || entry.variable.valueEncrypted === undefined
        ? {}
        : { valueEncrypted: entry.variable.valueEncrypted }),
    })),
  };
}

/** Capture the same immutable execution inputs for API, VCS and internally queued runs. */
export async function assembleRunProvenance(
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  cvId: string | undefined,
  configurationVersion: DeepReadonly<typeof configurationVersions.$inferSelect> | undefined,
  effectiveTool: string,
  effectiveVersion: string | null,
  id: string,
  createdAt: number,
  runVariablesInput: Parameters<typeof runVariablesForWrite>[0] | null,
): Promise<
  Readonly<{
    provenance: Awaited<ReturnType<typeof buildRunProvenanceCapsule>>;
    runVariables: Awaited<ReturnType<typeof runVariablesForWrite>> | null;
  }>
> {
  const [effectiveVariables, inputState] = await Promise.all([
    effectiveWorkspaceVariables(workspace.id, workspace.orgId, workspace.projectId ?? null),
    db.query.stateVersions.findFirst({
      where: and(eq(stateVersions.workspaceId, workspace.id), eq(stateVersions.status, "finalized")),
      orderBy: [desc(stateVersions.serial)],
      columns: { id: true, uploadSha256: true },
    }),
  ]);
  const runVariables = runVariablesInput === null ? null : await runVariablesForWrite(runVariablesInput);
  const provenance = await buildRunProvenanceCapsule({
    runId: id,
    createdAt,
    configurationVersionId: cvId ?? null,
    configurationSource: configurationVersion?.source ?? null,
    configurationIngress: configurationVersion?.ingressAttributes ?? null,
    configurationDigest: configurationDigest(configurationVersion),
    engine: effectiveTool,
    engineVersion: effectiveVersion ?? null,
    workspaceId: workspace.id,
    workingDirectory: workspace.workingDirectory,
    executionMode: workspace.executionMode,
    agentPoolId: workspace.agentPoolId,
    inputStateId: inputState?.id ?? null,
    inputStateDigest: inputState?.uploadSha256 ?? null,
    runVariables: runVariables ?? [],
    ...manifestVariables(effectiveVariables),
  });
  return { provenance, runVariables };
}

export function provenanceInsert(
  id: string,
  createdAt: number,
  provenance: Awaited<ReturnType<typeof buildRunProvenanceCapsule>>,
): typeof runProvenanceCapsules.$inferInsert {
  return {
    id: newResourceId("rpc"),
    runId: id,
    schemaVersion: provenance.publicManifest.schemaVersion,
    publicManifest: provenance.publicManifest,
    manifestSha256: provenance.manifestSha256,
    executionMaterial: provenance.executionMaterial,
    createdAt,
  };
}
