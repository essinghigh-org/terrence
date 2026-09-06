import { createHash } from "node:crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "../../db";
import { stateVersions, workspaces } from "../../db/schema";
import { decodeStatePayload, encryptStatePayload, isUniqueConstraintError, parseTerraformStatePayload, statePayloadError } from "../validation";
import { fenceStateWorkspace, stateReservationObsolete } from "../state-reservations";
import { replaceStateOutputIndex } from "../state-output-index";
import type { DeepReadonly } from "../utils";

type StateVersion = Readonly<typeof stateVersions.$inferSelect>;
type Workspace = DeepReadonly<typeof workspaces.$inferSelect>;
type WorkspaceRow = Readonly<typeof workspaces.$inferSelect>;
type Transaction = DeepReadonly<typeof db>;

export type CommitStateVersionInput = Readonly<{
  stateVersionId: string;
  rawState: string;
  now?: number;
}>;

export type CommitStateVersionResult = Readonly<
  | { kind: "committed"; stateVersionId: string }
  | { kind: "already-committed"; stateVersionId: string }
  | { kind: "not-found" }
  | { kind: "invalid"; reason: "state-payload" | "serial" | "reservation"; detail: string }
  | { kind: "conflict"; reason: "reservation-obsolete" | "content-already-uploaded" | "workspace-changed"; detail: string }
>;

function stateLineageError(
  previousState: Readonly<{ statePayload: string | null }> | undefined,
  incomingState: Readonly<Record<string, unknown>>,
): string | null {
  if (previousState === undefined) return null;
  if (typeof previousState.statePayload !== "string" || previousState.statePayload === "") {
    return "State lineage cannot be validated because the workspace history has no state payload";
  }
  let previous: Record<string, unknown> | null;
  try {
    previous = parseTerraformStatePayload(decodeStatePayload(previousState.statePayload));
  } catch {
    previous = null;
  }
  if (previous === null) {
    return "State lineage cannot be validated because the workspace history contains an invalid state payload";
  }
  return incomingState["lineage"] === previous["lineage"]
    ? null
    : "State lineage does not match the workspace history";
}

function sha256(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

function md5Matches(rawState: string, expected: string): boolean {
  const digest = createHash("md5").update(rawState).digest();
  return expected === digest.toString("base64") || expected.toLowerCase() === digest.toString("hex");
}

function conflict(
  reason: "reservation-obsolete" | "content-already-uploaded" | "workspace-changed",
  detail: string,
): CommitStateVersionResult {
  return { kind: "conflict", reason, detail };
}

type PayloadValidation = Readonly<
  | { ok: true; parsed: Record<string, unknown> }
  | { ok: false; result: Extract<CommitStateVersionResult, { kind: "invalid" }> }
>;

function validateReservationPayload(
  reservation: StateVersion,
  rawState: string,
): PayloadValidation {
  const parsedTerraformState = parseTerraformStatePayload(rawState);
  if (parsedTerraformState === null) {
    return {
      ok: false,
      result: {
        kind: "invalid",
        reason: "state-payload",
        detail: statePayloadError(rawState),
      },
    };
  }
  if (parsedTerraformState["serial"] !== reservation.serial) {
    return {
      ok: false,
      result: {
        kind: "invalid",
        reason: "serial",
        detail: "serial does not match the state reservation",
      },
    };
  }
  if (
    (reservation.expectedLineage !== null && parsedTerraformState["lineage"] !== reservation.expectedLineage)
    || (reservation.expectedMd5 !== null && !md5Matches(rawState, reservation.expectedMd5))
  ) {
    return {
      ok: false,
      result: {
        kind: "invalid",
        reason: "reservation",
        detail: "State bytes do not match the reserved checksum or lineage",
      },
    };
  }
  return { ok: true, parsed: parsedTerraformState };
}

function existingCommitResult(
  reservation: StateVersion,
  incomingSha256: string,
): CommitStateVersionResult | null {
  if (reservation.status === "finalized" && typeof reservation.statePayload === "string" && reservation.statePayload !== "") {
    const committedSha256 = reservation.uploadSha256 ?? sha256(decodeStatePayload(reservation.statePayload));
    return incomingSha256 === committedSha256
      ? { kind: "already-committed", stateVersionId: reservation.id }
      : conflict("content-already-uploaded", "State content was already uploaded");
  }
  if (reservation.status !== "pending" || (typeof reservation.statePayload === "string" && reservation.statePayload !== "")) {
    return conflict("content-already-uploaded", "State content was already uploaded");
  }
  return null;
}

async function commitPendingReservation(
  tx: Readonly<Transaction>,
  reservation: Readonly<StateVersion>,
  workspace: Workspace,
  parsedTerraformState: Readonly<Record<string, unknown>>,
  rawState: string,
  incomingSha256: string,
  now: number,
): Promise<CommitStateVersionResult> {
  const workspaceRow = workspace as WorkspaceRow;
  if (stateReservationObsolete(reservation, workspaceRow, now)) {
    return conflict(
      "reservation-obsolete",
      "State upload reservation expired or its workspace lock changed",
    );
  }
  if (!(await fenceStateWorkspace(tx as typeof db, workspaceRow))) {
    return conflict("workspace-changed", "State content was already uploaded");
  }

  const current = await tx.query.stateVersions.findFirst({
    where: and(
      eq(stateVersions.workspaceId, reservation.workspaceId),
      eq(stateVersions.status, "finalized"),
    ),
    orderBy: [desc(stateVersions.serial)],
  });
  if (current !== undefined && current.serial >= reservation.serial) {
    return conflict("content-already-uploaded", "State content was already uploaded");
  }
  const lineageError = stateLineageError(current, parsedTerraformState);
  if (lineageError !== null) {
    return { kind: "invalid", reason: "reservation", detail: lineageError };
  }

  const encrypted = await encryptStatePayload(rawState);
  const decodedJsonState = reservation.jsonState === null
    ? null
    : decodeStatePayload(reservation.jsonState);
  const finalized = await tx.update(stateVersions).set({
    statePayload: encrypted,
    status: "finalized",
    uploadSha256: incomingSha256,
  }).where(and(
    eq(stateVersions.id, reservation.id),
    eq(stateVersions.status, "pending"),
    or(isNull(stateVersions.statePayload), eq(stateVersions.statePayload, "")),
  )).returning({ id: stateVersions.id });
  if (finalized.length === 0) {
    return conflict("content-already-uploaded", "State content was already uploaded");
  }

  await replaceStateOutputIndex(
    tx,
    reservation.id,
    reservation.workspaceId,
    decodedJsonState,
    rawState,
  );
  return { kind: "committed", stateVersionId: reservation.id };
}

/**
 * Commit the bytes for a deferred state-version reservation.
 *
 * The caller owns transport concerns (body limits and authorization). This
 * command owns the lifecycle checks and transaction that make a state upload
 * a single, reusable state transition for API, worker, and agent callers.
 */
export async function commitStateVersion(
  input: CommitStateVersionInput,
): Promise<CommitStateVersionResult> {
  const incomingSha256 = sha256(input.rawState);
  const now = input.now ?? Date.now();

  try {
    return await db.transaction(async (transaction): Promise<CommitStateVersionResult> => {
      const tx = transaction as typeof db;
      const reservation = await tx.query.stateVersions.findFirst({
        where: eq(stateVersions.id, input.stateVersionId),
      });
      if (reservation === undefined) return { kind: "not-found" };

      // A retried request after a lost success response is idempotent. Keep
      // this branch before parsing so a stale client gets the same conflict
      // semantics as the route did for an already committed version.
      const existing = existingCommitResult(reservation, incomingSha256);
      if (existing !== null) {
        if (existing.kind === "already-committed" && reservation.uploadSha256 === null) {
          await tx.update(stateVersions)
            .set({ uploadSha256: incomingSha256 })
            .where(eq(stateVersions.id, reservation.id));
        }
        return existing;
      }
      const workspace = await tx.query.workspaces.findFirst({
        where: eq(workspaces.id, reservation.workspaceId),
      });
      if (workspace === undefined) return { kind: "not-found" };
      if (stateReservationObsolete(reservation, workspace, now)) {
        return conflict(
          "reservation-obsolete",
          "State upload reservation expired or its workspace lock changed",
        );
      }
      const payload = validateReservationPayload(reservation, input.rawState);
      if (!payload.ok) return payload.result;
      return commitPendingReservation(
        tx,
        reservation,
        workspace,
        payload.parsed,
        input.rawState,
        incomingSha256,
        now,
      );
    });
  } catch (error: unknown) {
    if (isUniqueConstraintError(error)) {
      return conflict("content-already-uploaded", "State content was already uploaded");
    }
    throw error;
  }
}
