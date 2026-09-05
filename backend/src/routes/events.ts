import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import type { users } from "../db/schema";
import { organizationMemberships } from "../db/schema";
import { authPlugin } from "../auth";
import { subscribe } from "../lib/event-bus";
import { workspaceIdsForPermission } from "../lib/utils";

type ParamCtx = Readonly<{
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  request: Request;
  set: Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;
}>;

const HEARTBEAT_MS = 15_000;
const MAX_CONNECTIONS = 50;
const MAX_CONNECTIONS_PER_USER = 5;
// Topics relayed to browser streams. Each payload must carry "org-id" (and
// ideally "workspace-id"/"run-id") so the connect-time permission snapshot
// can filter it in memory by org and workspace.
const RELAYED_TOPICS = ["run.status", "plan.output.ready", "comment.created"] as const;
let activeConnections = 0;
const activeConnectionsByUser = new Map<string, number>();

function sseFrame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Union of readable workspace ids across orgs for an SSE snapshot. Returns
 * null when any org grants org-wide read (callers then skip workspace
 * filtering for the whole stream).
 */
async function readableWorkspaceIdsForOrgs(
  orgIds: readonly string[],
  userId: string,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
): Promise<Set<string> | null> {
  const union = new Set<string>();
  for (const id of orgIds) {
    const ids = await workspaceIdsForPermission(id, userId, tokenOrgId, tokenTeamId, "read");
    if (ids === null) return null;
    for (const workspaceId of ids) union.add(workspaceId);
  }
  return union;
}

/**
 * Authenticated Server-Sent Events stream. Replaces client polling
 * for run status: worker status transitions are published on the in-process
 * bus and relayed to every connection whose principal belongs to the
 * event's organization and can read the event's workspace. Permissions are
 * resolved once at connect time (org memberships / org token / site admin),
 * then events are filtered in memory. Heartbeats keep proxies and dead
 * connections honest.
 */
export const eventsRoutes = new Elysia({ name: "events" })
  .use(authPlugin)
  .get("/api/v2/events", async ({ user, orgId, teamId, request }: ParamCtx): Promise<Response> => {
    if (user === null || user === undefined) {
      return new Response(JSON.stringify({ errors: [{ status: "401", title: "Unauthorized" }] }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (activeConnections >= MAX_CONNECTIONS) {
      return new Response(JSON.stringify({ errors: [{ status: "503", title: "Service Unavailable", detail: "Too many event streams" }] }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    const userStreams = activeConnectionsByUser.get(user.id) ?? 0;
    if (userStreams >= MAX_CONNECTIONS_PER_USER) {
      return new Response(JSON.stringify({ errors: [{ status: "503", title: "Service Unavailable", detail: "Too many event streams for this user" }] }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Reserve the slot BEFORE the async membership lookup so concurrent
    // connects cannot both pass the cap check; the reservation is released
    // on abort, stream cancel, or the one-hour lifetime limit.
    activeConnections += 1;
    activeConnectionsByUser.set(user.id, userStreams + 1);
    let slotReserved = true;
    const releaseSlot = (): void => {
      if (!slotReserved) return;
      slotReserved = false;
      activeConnections = Math.max(0, activeConnections - 1);
      const remaining = (activeConnectionsByUser.get(user.id) ?? 1) - 1;
      if (remaining <= 0) activeConnectionsByUser.delete(user.id);
      else activeConnectionsByUser.set(user.id, remaining);
    };

    // Allowed orgs resolved once: site admins see everything; org tokens see
    // their org; users see their memberships.
    let allowedOrgIds: Set<string> | null = null;
    // Readable workspaces resolved once alongside the orgs (issue #645): a
    // null set means org-wide read access, otherwise events for other
    // workspaces are dropped even inside an allowed org.
    let readableWorkspaceIds: Set<string> | null = null;
    try {
      if (user.isSiteAdmin === true) {
        allowedOrgIds = null; // null = all orgs
        readableWorkspaceIds = null; // null = all workspaces
      } else if (orgId !== null && orgId !== undefined) {
        allowedOrgIds = new Set([orgId]);
        readableWorkspaceIds = await readableWorkspaceIdsForOrgs([orgId], user.id, orgId, teamId);
      } else {
        const memberships = await db.query.organizationMemberships.findMany({
          where: eq(organizationMemberships.userId, user.id),
          columns: { orgId: true },
        });
        const memberOrgIds = memberships.map((row): string => row.orgId);
        allowedOrgIds = new Set(memberOrgIds);
        readableWorkspaceIds = await readableWorkspaceIdsForOrgs(memberOrgIds, user.id, null, teamId);
      }
    } catch {
      releaseSlot();
      return new Response(JSON.stringify({ errors: [{ status: "500", title: "Internal Server Error" }] }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Shared across start()/cancel(): the stream's lifecycle must release
    // the subscriptions and the connection slot exactly once from either the
    // request abort signal, a client-side reader cancel, an enqueue failure,
    // or the one-hour lifetime cap (permissions are re-resolved on
    // reconnect).
    let disposeSubscriptions: () => void = (): void => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let cleanup: () => void = (): void => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>) {
        let cleanedUp = false;
        const baseCleanup = (): void => {
          if (cleanedUp) return;
          cleanedUp = true;
          disposeSubscriptions();
          if (heartbeat !== undefined) clearInterval(heartbeat);
          releaseSlot();
          try {
            controller.close();
          } catch {
            // Already closed or errored; nothing to do.
          }
        };
        // The wrapped cleanup (which also clears the lifetime timer) is
        // installed BEFORE abort registration so an already-aborted request
        // always runs the full cleanup path.
        cleanup = (): void => {
          if (lifetime !== undefined) clearTimeout(lifetime);
          baseCleanup();
        };
        let lifetime: ReturnType<typeof setTimeout> | undefined;
        const enqueue = (event: string, data: unknown): void => {
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            // Backpressure: the client stopped reading; end the stream and
            // let the client reconnect.
            cleanup();
            return;
          }
          try {
            controller.enqueue(sseFrame(event, data));
          } catch {
            cleanup();
          }
        };
        enqueue("connected", { heartbeatMs: HEARTBEAT_MS });

        // One subscription per relayed topic; all are disposed by the
        // shared cleanup path so a dead connection can never leak a
        // listener on the bus.
        const disposers: (() => void)[] = [];
        disposeSubscriptions = (): void => {
          for (const dispose of disposers) dispose();
          disposers.length = 0;
        };
        // The connected frame may already have failed (backpressure) and
        // run cleanup: registering listeners now would leave them on the
        // bus forever because cleanup can never run again.
        if (cleanedUp) return;
        for (const topic of RELAYED_TOPICS) {
          disposers.push(subscribe(topic, (payload: Readonly<Record<string, unknown>>): void => {
            const eventOrgId = typeof payload["org-id"] === "string" ? payload["org-id"] : "";
            if (allowedOrgIds !== null && (eventOrgId === "" || !allowedOrgIds.has(eventOrgId))) return;
            // Issue #645: org membership alone must not leak run metadata
            // for workspaces the principal cannot read. The snapshot is
            // connect-time (re-resolved on reconnect); events without a
            // workspace id keep the org-only behavior.
            if (readableWorkspaceIds !== null) {
              const eventWorkspaceId = typeof payload["workspace-id"] === "string" ? payload["workspace-id"] : "";
              if (eventWorkspaceId !== "" && !readableWorkspaceIds.has(eventWorkspaceId)) return;
            }
            enqueue(topic, payload);
          }));
        }
        // Control topic, never relayed: membership revocation or user
        // suspension closes this user's stream so the browser reconnects and
        // re-resolves its permission snapshot immediately instead of after
        // the one-hour reconnect cap (scratch review: authorization lag).
        disposers.push(subscribe("authz.changed", (payload: Readonly<Record<string, unknown>>): void => {
          const targetUserId = typeof payload["user-id"] === "string" ? payload["user-id"] : "";
          if (targetUserId !== "" && targetUserId === user.id) cleanup();
        }));

        heartbeat = setInterval((): void => {
          enqueue("ping", { at: new Date().toISOString() });
        }, HEARTBEAT_MS);

        // One-hour lifetime: the permission snapshot ages; closing forces
        // clients to reconnect and re-resolve permissions.
        lifetime = setTimeout(cleanup, 60 * 60 * 1000);
        const abort = (): void => {
          cleanup();
        };
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
      },
      cancel(): void {
        // Client disconnected (reader canceled): release the subscription
        // and the connection slot without waiting for an abort event.
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });
