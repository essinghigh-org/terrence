import { newResourceId } from "./resource-id";
import { randomBytes, randomUUID } from "node:crypto";
import { hashAuthenticationToken } from "./token-service";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db";
import { runs, runTokens, workspaces } from "../db/schema";

/** Run tokens are valid for at most 24h, even if the run never finishes. */
export const RUN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Mint an ephemeral credential for a run (the reference format run-token model).
 *
 * The plaintext token is returned EXACTLY ONCE to the caller (the worker,
 * which writes it into the run's private CLI config file). Only the keyed
 * token hash is stored, so the API layer can authenticate it later without
 * being able to recover the plaintext.
 */
export async function mintRunToken(
  runId: string,
  workspaceId: string,
  organizationId: string,
): Promise<string> {
  const token = `trun_${randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  await db.insert(runTokens).values({
    id: newResourceId("rtok"),
    tokenHash: hashRunToken(token),
    runId,
    workspaceId,
    organizationId,
    createdAt: now,
    expiresAt: now + RUN_TOKEN_TTL_MS,
    revokedAt: null,
  });
  return token;
}

/** Explicitly revoke all tokens for a run (called on terminal state). */
export async function revokeRunTokens(runId: string): Promise<void> {
  await db.update(runTokens).set({ revokedAt: Date.now() }).where(eq(runTokens.runId, runId));
}

/**
 * Rotate every live run-log capability in an organization (issue #699).
 * Log links are HMACs over the run's logToken, so replacing it invalidates
 * all outstanding links immediately; authorized clients fetch fresh links
 * from the plan/apply responses. Soft-deleted runs are skipped: they can
 * neither issue nor honor links. Returns the rotated run count.
 */
export async function rotateOrgRunLogTokens(orgId: string): Promise<number> {
  const orgWorkspaces = await db.query.workspaces.findMany({
    where: eq(workspaces.orgId, orgId),
    columns: { id: true },
  });
  if (orgWorkspaces.length === 0) return 0;
  const live = await db.query.runs.findMany({
    where: and(
      inArray(runs.workspaceId, orgWorkspaces.map((row): string => row.id)),
      isNotNull(runs.logToken),
      isNull(runs.softDeletedAt),
    ),
    columns: { id: true },
  });
  for (const run of live) {
    await db.update(runs).set({ logToken: randomUUID() }).where(eq(runs.id, run.id));
  }
  return live.length;
}

export function hashRunToken(token: string): string {
  return hashAuthenticationToken(token);
}

/**
 * Write the Terraform CLI config file carrying the run token, scoped to the
 * registry hostname, into the run workdir's private secrets directory
 * (mode 0600). Returns the path to set as TF_CLI_CONFIG_FILE.
 */
export async function writeRunCliConfig(
  workDir: string,
  hostname: string,
  token: string,
): Promise<string> {
  const secretsDir = join(workDir, "secrets");
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  const configPath = join(secretsDir, "terraform.tfrc");
  // HCL double-quoted strings use JSON-compatible escapes, so JSON.stringify
  // (with JSON_HEX_TAG etc.) is the correct escaping for both fields.
  const hclValue = (value: string): string => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  const content = `credentials ${hclValue(hostname)} {
  token = ${hclValue(token)}
}
`;
  await writeFile(configPath, content, { mode: 0o600 });
  return configPath;
}
