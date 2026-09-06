import { createHash } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../db";
import { apiIdempotencyKeys } from "../db/schema";
import { databaseConstraint } from "./database-errors";
import { canonicalJson } from "./run-provenance";
import { newResourceId } from "./resource-id";

/** Stored idempotency responses are retained long enough for CLI retries. */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export type IdempotencySet = Readonly<{
  status?: number | string;
  headers: Readonly<Record<string, string | number>>;
}>;

export type IdempotencyContext = Readonly<{
  key: string;
  scope: string;
  principal: string;
  requestHash: string;
}>;

export type IdempotencyBegin = Readonly<
  | { kind: "none" }
  | { kind: "reserved"; id: string }
  | { kind: "replay"; status: number; body: Record<string, unknown>; resourceId: string | null }
  | { kind: "error"; status: 400 | 409; detail: string; retryAfter?: number }
>;

/** A canonical JSON hash makes semantically identical object key order replayable. */
export function idempotencyHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Caller identity used for the key binding; object authorization remains separate. */
export function idempotencyPrincipal(input: Readonly<{
  userId?: string | null | undefined;
  teamId?: string | null | undefined;
  orgId?: string | null | undefined;
  runId?: string | null | undefined;
}>): string {
  if (typeof input.userId === "string" && input.userId !== "") return `user:${input.userId}`;
  if (typeof input.teamId === "string" && input.teamId !== "") return `team:${input.teamId}`;
  if (typeof input.orgId === "string" && input.orgId !== "") return `organization:${input.orgId}`;
  if (typeof input.runId === "string" && input.runId !== "") return `run:${input.runId}`;
  return "anonymous";
}

/** Parse the optional request header without accepting ambiguous/unsafe keys. */
export function idempotencyContext(
  request: Readonly<{ headers: Readonly<{ get(name: string): string | null }> }>,
  scope: string,
  principal: string,
  body: unknown,
  set?: IdempotencySet,
): IdempotencyContext | "invalid" | null {
  const raw = request.headers.get("Idempotency-Key");
  if (raw === null) return null;
  const key = raw.trim();
  if (key === "" || key.length > IDEMPOTENCY_KEY_MAX_LENGTH || /[\r\n]/.test(key)) {
    if (set !== undefined) (set as { status?: number | string }).status = 400;
    return "invalid";
  }
  return { key, scope, principal, requestHash: idempotencyHash(body) };
}

/**
 * Reserve a key before a mutating operation. A second caller with the same
 * key cannot enter the operation while the first is pending. Replays return
 * the original JSON:API document and status; mismatches are conflicts.
 */
export async function beginIdempotency(
  context: IdempotencyContext | null,
  resourceType: string,
  set?: IdempotencySet,
): Promise<IdempotencyBegin> {
  if (context === null) return { kind: "none" };
  const now = Date.now();
  await db.delete(apiIdempotencyKeys).where(and(
    eq(apiIdempotencyKeys.scope, context.scope),
    eq(apiIdempotencyKeys.key, context.key),
    lt(apiIdempotencyKeys.expiresAt, now),
  ));
  let existing = await db.query.apiIdempotencyKeys.findFirst({
    where: and(eq(apiIdempotencyKeys.scope, context.scope), eq(apiIdempotencyKeys.key, context.key)),
  });
  if (existing === undefined) {
    const id = newResourceId("idem");
    try {
      await db.insert(apiIdempotencyKeys).values({
        id,
        scope: context.scope,
        key: context.key,
        principal: context.principal,
        requestHash: context.requestHash,
        resourceType,
        resourceId: null,
        status: "pending",
        responseStatus: null,
        responseBody: null,
        createdAt: now,
        expiresAt: now + IDEMPOTENCY_RETENTION_MS,
        completedAt: null,
      });
      return { kind: "reserved", id };
    } catch (error: unknown) {
      if (databaseConstraint(error) !== "unique") throw error;
      existing = await db.query.apiIdempotencyKeys.findFirst({
        where: and(eq(apiIdempotencyKeys.scope, context.scope), eq(apiIdempotencyKeys.key, context.key)),
      });
    }
  }
  if (existing === undefined) return { kind: "error", status: 409, detail: "The idempotency key could not be reserved" };
  if (existing.principal !== context.principal || existing.requestHash !== context.requestHash || existing.resourceType !== resourceType) {
    if (set !== undefined) (set as { status?: number | string }).status = 409;
    return { kind: "error", status: 409, detail: "Idempotency-Key was already used with a different principal, resource, or request body" };
  }
  if (existing.status !== "completed" || existing.responseStatus === null || existing.responseBody === null) {
    if (set !== undefined) {
      (set as { status?: number | string }).status = 409;
      (set as { headers: Record<string, string | number> }).headers["Retry-After"] = 1;
    }
    return { kind: "error", status: 409, detail: "An operation with this Idempotency-Key is already in progress", retryAfter: 1 };
  }
  if (set !== undefined) {
    (set as { status?: number | string }).status = existing.responseStatus;
    (set as { headers: Record<string, string | number> }).headers["Idempotency-Replayed"] = "true";
  }
  return { kind: "replay", status: existing.responseStatus, body: existing.responseBody, resourceId: existing.resourceId };
}

/** Remove a reservation when validation or a precondition fails before a resource is created. */
export async function abandonIdempotency(id: string): Promise<void> {
  await db.delete(apiIdempotencyKeys).where(eq(apiIdempotencyKeys.id, id));
}

export async function completeIdempotency(
  id: string,
  responseStatus: number,
  responseBody: Readonly<Record<string, unknown>>,
  resourceId?: string | null,
): Promise<void> {
  await db.update(apiIdempotencyKeys).set({
    status: "completed",
    responseStatus,
    responseBody,
    resourceId: resourceId ?? null,
    completedAt: Date.now(),
  }).where(eq(apiIdempotencyKeys.id, id));
}

export function idempotencyError(
  result: Extract<IdempotencyBegin, { kind: "error" }>,
): { errors: { status: string; title: string; detail: string }[] } {
  return {
    errors: [{
      status: String(result.status),
      title: result.status === 400 ? "Bad Request" : "Conflict",
      detail: result.detail,
    }],
  };
}
