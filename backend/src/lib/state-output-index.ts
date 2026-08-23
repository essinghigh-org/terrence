import { createHash } from "node:crypto";
import { db } from "../db";
import { stateOutputIndex } from "../db/schema";
import { parseStatePayload } from "./validation";

export function stateOutputIndexRows(
  stateVersionId: string,
  workspaceId: string,
  jsonState: string | null,
  statePayload: string | null,
): (typeof stateOutputIndex.$inferInsert)[] {
  const parsed = parseStatePayload(jsonState ?? statePayload);
  const isBareOutputs = parsed !== null
    && !["version", "terraform_version", "serial", "lineage", "resources", "check_results", "outputs"].some((key): boolean => key in parsed);
  const outputs = parsed?.outputs ?? (statePayload === null && isBareOutputs ? parsed : undefined);
  if (outputs === null || outputs === undefined || typeof outputs !== "object" || Array.isArray(outputs)) return [];
  return Object.keys(outputs).map((name): typeof stateOutputIndex.$inferInsert => ({
    outputId: `wsout-${createHash("sha256").update(`${stateVersionId}\0${name}`).digest("hex").slice(0, 16)}`,
    stateVersionId,
    workspaceId,
    name,
    createdAt: Date.now(),
  }));
}

export async function insertStateOutputIndex(
  tx: unknown,
  stateVersionId: string,
  workspaceId: string,
  jsonState: string | null,
  statePayload: string | null,
): Promise<void> {
  const rows = stateOutputIndexRows(stateVersionId, workspaceId, jsonState, statePayload);
  if (rows.length === 0) return;
  await (tx as typeof db).insert(stateOutputIndex).values(rows);
}
