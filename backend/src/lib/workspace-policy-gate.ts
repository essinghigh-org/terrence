import { and, eq, inArray } from "drizzle-orm";
import type { db } from "../db";
import { policySets } from "../db/schema";
import { resolveWorkspacePolicySetIds } from "./policy-set-scope";

/** Recheck immediately before apply: policy scope may have changed after plan.
 * BYOB alone is not an enforcement guarantee: Terraform can continue applying
 * after tfpolicy-plugin startup fails. Keep this gate until native execution
 * has a verified fail-closed contract, including agent execution. */
export async function workspacePolicyExecutionError(
  // Drizzle query clients are stateful, including transaction-bound clients.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Readonly<typeof db>,
  workspace: Readonly<{ id: string; orgId: string }>,
): Promise<string | null> {
  const ids = await resolveWorkspacePolicySetIds(database, workspace.id, workspace.orgId);
  if (ids.length === 0) return null;
  const unsupported = await database.query.policySets.findFirst({
    where: and(inArray(policySets.id, ids), eq(policySets.orgId, workspace.orgId), eq(policySets.kind, "tfpolicy")),
  });
  return unsupported === undefined
    ? null
    : `Apply blocked: tfpolicy policy set ${unsupported.name} (${unsupported.id}) cannot be evaluated because the tfpolicy runtime is not supported`;
}
