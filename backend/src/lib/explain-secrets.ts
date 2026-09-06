import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  runs,
  stateVersions,
  variableSetWorkspaces,
  variableSetVariables,
  variableSets,
  workspaces,
  workspaceVariables,
} from "../db/schema";
import { parseStatePayload, decodeStatePayload } from "./validation";
import { variableValueForRead } from "./variable-crypto";

/**
 * Secret egress minimization for the AI run explainer (issue #687).
 *
 * The sanitized plan projection (SEC-01) redacts by structure, but apply
 * logs have no structure and repository strings can echo values anywhere,
 * so outbound prompts are additionally scrubbed by value. Secrets are
 * gathered from exactly the material the run could observe: sensitive
 * workspace variables, attached and global variable-set values, and
 * sensitive outputs of the workspace's latest finalized state. Values
 * never leave this module except inside the redacted output; only counts
 * are reported to logs and audit records.
 */
export const EXPLAIN_SECRET_MIN_LENGTH = 8;

export const EXPLAIN_REDACTED_MARKER = "[redacted]";

export async function collectExplainSecrets(runId: string): Promise<readonly string[]> {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId), columns: { workspaceId: true } });
  if (run === undefined) return [];
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, run.workspaceId),
    columns: { id: true, orgId: true },
  });
  if (workspace === undefined) return [];
  const [wsVars, links, globalSets] = await Promise.all([
    db.query.workspaceVariables.findMany({
      where: and(eq(workspaceVariables.workspaceId, workspace.id), eq(workspaceVariables.sensitive, true)),
    }),
    db.query.variableSetWorkspaces.findMany({ where: eq(variableSetWorkspaces.workspaceId, workspace.id) }),
    db.query.variableSets.findMany({
      where: and(eq(variableSets.orgId, workspace.orgId), eq(variableSets.global, true)),
      columns: { id: true },
    }),
  ]);
  const setIds = [...new Set([...links.map((link) => link.variableSetId), ...globalSets.map((set) => set.id)])];
  const setVars = setIds.length === 0
    ? []
    : await db.query.variableSetVariables.findMany({
      where: and(inArray(variableSetVariables.variableSetId, setIds), eq(variableSetVariables.sensitive, true)),
    });
  const latest = await db.query.stateVersions.findFirst({
    where: and(eq(stateVersions.workspaceId, workspace.id), eq(stateVersions.status, "finalized")),
    orderBy: [desc(stateVersions.serial)],
  });
  const values: string[] = [];
  for (const row of [...wsVars, ...setVars]) {
    try {
      values.push(await variableValueForRead(row));
    } catch {
      continue;
    }
  }
  for (const secret of sensitiveOutputSecrets(latest?.statePayload == null ? null : decodeStatePayload(latest.statePayload))) values.push(secret);
  return [...new Set(values.filter((value) => value.length >= EXPLAIN_SECRET_MIN_LENGTH))];
}

/** Candidate secret strings from one sensitive output value. */
function secretStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || value === undefined) return [];
  try {
    const encoded = JSON.stringify(value) ?? "";
    return encoded === "" ? [] : [encoded];
  } catch {
    return [];
  }
}

/** Scalar (and stringified composite) values of outputs flagged sensitive. Takes the decoded state document. */
export function sensitiveOutputSecrets(decodedPayload: string | null): string[] {
  if (decodedPayload === null) return [];
  const parsed = parseStatePayload(decodedPayload);
  const outputs = parsed?.["outputs"];
  if (outputs === null || outputs === undefined || typeof outputs !== "object" || Array.isArray(outputs)) return [];
  const secrets: string[] = [];
  for (const raw of Object.values(outputs)) {
    const output: Record<string, unknown> = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : { value: raw };
    if (output["sensitive"] !== true) continue;
    secrets.push(...secretStrings(output["value"]));
  }
  return secrets;
}

export type RedactionResult = Readonly<{ text: string; hits: number }>;

/**
 * Replace every known secret occurrence with the marker, longest first so
 * a short value nested inside a longer one cannot fragment the match.
 * Literal matching (no patterns): values are data, never expressions.
 */
export function redactKnownSecrets(text: string, secrets: readonly string[]): RedactionResult {
  let redacted = text;
  let hits = 0;
  const ordered = [...new Set(secrets.filter((secret) => secret.length >= EXPLAIN_SECRET_MIN_LENGTH))]
    .sort((left, right) => right.length - left.length);
  for (const secret of ordered) {
    if (!redacted.includes(secret)) continue;
    hits += redacted.split(secret).length - 1;
    redacted = redacted.split(secret).join(EXPLAIN_REDACTED_MARKER);
  }
  return { text: redacted, hits };
}
