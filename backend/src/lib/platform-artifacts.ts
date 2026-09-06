import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { durableJobs } from "../db/schema";
import { newResourceId } from "./resource-id";
import { canonicalJson, sha256Hex } from "./run-provenance";

/**
 * Platform workflows deliberately share the durable-jobs table. These rows
 * are records, not executable jobs: their names are not claimed by the
 * worker. Reusing the table gives comparisons and previews restart-safe IDs
 * without adding a second queue or a second retention mechanism.
 */
export const PLATFORM_ARTIFACT_SCHEMA_VERSION = 1;

export type PlatformArtifactKind =
  | "state-comparison"
  | "plan-comparison"
  | "fleet-operation"
  | "promotion"
  | "dependency-impact"
  | "drift-incident"
  | "import-workbench"
  | "upgrade-rehearsal"
  | "policy-playground";

export type PlatformArtifact = Readonly<typeof durableJobs.$inferSelect> & {
  readonly kind: PlatformArtifactKind;
};

type ArtifactPayload = Readonly<Record<string, unknown>>;

function isArtifactKind(value: string): value is PlatformArtifactKind {
  return [
    "state-comparison", "plan-comparison", "fleet-operation", "promotion",
    "dependency-impact", "drift-incident", "import-workbench",
    "upgrade-rehearsal", "policy-playground",
  ].includes(value);
}

function organizationIdOf(payload: ArtifactPayload): string | null {
  return typeof payload["organizationId"] === "string" ? payload["organizationId"] : null;
}

function workspaceIdOf(payload: ArtifactPayload): string | null {
  return typeof payload["workspaceId"] === "string" ? payload["workspaceId"] : null;
}

function boundedPayload(payload: ArtifactPayload): Record<string, unknown> {
  const value = JSON.parse(canonicalJson(payload)) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Platform artifact payload must be an object");
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 512 * 1024) {
    throw new Error("Platform artifact payload exceeds the 512 KiB limit");
  }
  return value as Record<string, unknown>;
}

export function platformArtifactDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export async function createPlatformArtifact(input: Readonly<{
  kind: PlatformArtifactKind;
  organizationId: string;
  workspaceId?: string | null;
  actorId?: string | null;
  payload: ArtifactPayload;
  status?: string;
  dedupeKey?: string;
  runAfter?: number;
}>): Promise<PlatformArtifact> {
  const payload = boundedPayload({
    ...input.payload,
    organizationId: input.organizationId,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    schemaVersion: PLATFORM_ARTIFACT_SCHEMA_VERSION,
  });
  if (input.dedupeKey !== undefined) {
    const existing = await db.query.durableJobs.findFirst({
      where: and(eq(durableJobs.kind, input.kind), eq(durableJobs.dedupeKey, input.dedupeKey)),
    });
    if (existing !== undefined && isArtifactKind(existing.kind)) return existing as PlatformArtifact;
  }
  const now = Date.now();
  const row: typeof durableJobs.$inferInsert = {
    id: newResourceId("platform"),
    kind: input.kind,
    dedupeKey: input.dedupeKey ?? null,
    status: input.status ?? "completed",
    payload,
    payloadSchemaVersion: PLATFORM_ARTIFACT_SCHEMA_VERSION,
    attempts: 0,
    runAfter: input.runAfter ?? now,
    lockedBy: null,
    lockToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.insert(durableJobs).values(row);
  } catch (error: unknown) {
    if (input.dedupeKey === undefined) throw error;
    const existing = await db.query.durableJobs.findFirst({
      where: and(eq(durableJobs.kind, input.kind), eq(durableJobs.dedupeKey, input.dedupeKey)),
    });
    if (existing === undefined || !isArtifactKind(existing.kind)) throw error;
    return existing as PlatformArtifact;
  }
  return row as PlatformArtifact;
}

export async function getPlatformArtifact(
  id: string,
  kind: PlatformArtifactKind,
  organizationId: string,
): Promise<PlatformArtifact | undefined> {
  const row = await db.query.durableJobs.findFirst({ where: and(eq(durableJobs.id, id), eq(durableJobs.kind, kind)) });
  if (row === undefined || !isArtifactKind(row.kind) || organizationIdOf(row.payload) !== organizationId) return undefined;
  return row as PlatformArtifact;
}

export async function listPlatformArtifacts(input: Readonly<{
  kind: PlatformArtifactKind;
  organizationId: string;
  workspaceId?: string | null;
  limit?: number;
}>): Promise<readonly PlatformArtifact[]> {
  const rows = await db.query.durableJobs.findMany({
    where: eq(durableJobs.kind, input.kind),
    orderBy: [desc(durableJobs.createdAt), desc(durableJobs.id)],
    limit: Math.min(Math.max(input.limit ?? 200, 1), 500),
  });
  return rows.filter((row): row is PlatformArtifact =>
    isArtifactKind(row.kind)
    && organizationIdOf(row.payload) === input.organizationId
    && (input.workspaceId === undefined || input.workspaceId === null || workspaceIdOf(row.payload) === input.workspaceId),
  );
}

export async function updatePlatformArtifact(
  id: string,
  kind: PlatformArtifactKind,
  organizationId: string,
  update: Readonly<{ status?: string; payload?: ArtifactPayload }>,
): Promise<PlatformArtifact | undefined> {
  const current = await getPlatformArtifact(id, kind, organizationId);
  if (current === undefined) return undefined;
  const payload = update.payload === undefined ? current.payload : boundedPayload({
    ...update.payload,
    organizationId,
    schemaVersion: PLATFORM_ARTIFACT_SCHEMA_VERSION,
  });
  const rows = await db.update(durableJobs).set({
    ...(update.status === undefined ? {} : { status: update.status }),
    payload,
    payloadSchemaVersion: PLATFORM_ARTIFACT_SCHEMA_VERSION,
    updatedAt: Date.now(),
  }).where(and(eq(durableJobs.id, id), eq(durableJobs.kind, kind))).returning();
  const row = rows[0];
  return row === undefined || !isArtifactKind(row.kind) ? undefined : row as PlatformArtifact;
}

export function artifactPayload(row: PlatformArtifact): Record<string, unknown> {
  return { ...row.payload };
}

export function artifactResource(row: PlatformArtifact, type: string = row.kind): Record<string, unknown> {
  const payload = artifactPayload(row);
  delete payload["organizationId"];
  delete payload["actorId"];
  delete payload["schemaVersion"];
  return {
    id: row.id,
    type,
    attributes: {
      ...payload,
      status: row.status,
      "created-at": new Date(row.createdAt).toISOString(),
      "updated-at": new Date(row.updatedAt).toISOString(),
    },
    meta: {
      "payload-schema-version": row.payloadSchemaVersion,
      "record-digest": platformArtifactDigest(row.payload),
    },
    links: { self: `/api/v2/platform/${type}/${row.id}` },
  };
}
