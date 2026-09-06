import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { db } from "../db";
import { stateOutputIndex, stateVersions } from "../db/schema";
import { buildStateSummary } from "./state-summary";
import { parseStatePayload } from "./validation";

export const STATE_OUTPUT_INDEX_BATCH_SIZE = 200;

export function stateOutputIndexRows(
  stateVersionId: string,
  workspaceId: string,
  jsonState: string | null,
  statePayload: string | null,
): (typeof stateOutputIndex.$inferInsert)[] {
  const parsed = parseStatePayload(statePayload ?? jsonState);
  const isBareOutputs = parsed !== null
    && !["version", "terraform_version", "serial", "lineage", "resources", "check_results", "outputs"].some((key): boolean => key in parsed);
  const outputs = parsed?.["outputs"] ?? (statePayload === null && isBareOutputs ? parsed : undefined);
  if (outputs === null || outputs === undefined || typeof outputs !== "object" || Array.isArray(outputs)) return [];
  return Object.keys(outputs).map((name): typeof stateOutputIndex.$inferInsert => ({
    outputId: `wsout-${createHash("sha256").update(`${stateVersionId}\0${name}`).digest("hex")}`,
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
  const summary = statePayload === null ? null : buildStateSummary(statePayload);
  await (tx as typeof db).update(stateVersions).set({
    stateSummary: summary === null ? null : JSON.stringify(summary),
    ...(summary === null ? {} : { uploadSha256: summary.digest }),
  }).where(eq(stateVersions.id, stateVersionId));
  const rows = stateOutputIndexRows(stateVersionId, workspaceId, jsonState, statePayload);
  if (rows.length === 0) return;
  for (let offset = 0; offset < rows.length; offset += STATE_OUTPUT_INDEX_BATCH_SIZE) {
    await (tx as typeof db).insert(stateOutputIndex)
      .values(rows.slice(offset, offset + STATE_OUTPUT_INDEX_BATCH_SIZE))
      .onConflictDoNothing();
  }
}

/** Rebuild the output index for an existing version (issue #578). Upload
 * endpoints rewrite version content, so appending would mix output names
 * from the losing writer's state with the winner's: delete first, then
 * insert. Callers must run this in the same transaction as the content
 * update so a crash cannot leave an emptied index beside new content.
 */
export async function replaceStateOutputIndex(
  tx: unknown,
  stateVersionId: string,
  workspaceId: string,
  jsonState: string | null,
  statePayload: string | null,
): Promise<void> {
  const store = tx as typeof db;
  await store.delete(stateOutputIndex).where(eq(stateOutputIndex.stateVersionId, stateVersionId));
  await insertStateOutputIndex(tx, stateVersionId, workspaceId, jsonState, statePayload);
}
