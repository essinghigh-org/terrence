import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { organizationMemberships, users } from "../db/schema";
import { authPlugin } from "../auth";
import { subscribe } from "../lib/event-bus";

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
let activeConnections = 0;
const activeConnectionsByUser = new Map<string, number>();

function sseFrame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Authenticated Server-Sent Events stream (10.20). Replaces client polling
 * for run status: worker status transitions are published on the in-process
 * bus and relayed to every connection whose principal belongs to the
 * event's organization. Permissions are resolved once at connect time
 * (org memberships / org token / site admin), then events are filtered in
 * memory. Heartbeats keep proxies and dead connections honest.
 */
export const eventsRoutes = new Elysia({ name: "events" })
  .use(authPlugin)
  .get("/api/v2/events", async ({ user, orgId, request }: ParamCtx): Promise<Response> => {
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
    try {
      if (user.isSiteAdmin === true) {
        allowedOrgIds = null; // null = all orgs
      } else if (orgId !== null && orgId !== undefined) {
        allowedOrgIds = new Set([orgId]);
      } else {
        const memberships = await db.query.organizationMemberships.findMany({
          where: eq(organizationMemberships.userId, user.id),
          columns: { orgId: true },
        });
        allowedOrgIds = new Set(memberships.map((row): string => row.orgId));
      }
    } catch {
      releaseSlot();
      return new Response(JSON.stringify({ errors: [{ status: "500", title: "Internal Server Error" }] }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Shared across start()/cancel(): the stream's lifecycle must release
    // the subscription and the connection slot exactly once from either the
    // request abort signal, a client-side reader cancel, an enqueue failure,
    // or the one-hour lifetime cap (permissions are re-resolved on
    // reconnect).
    let unsubscribe: () => void = (): void => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let cleanup: () => void = (): void => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>) {
        let cleanedUp = false;
        const baseCleanup = (): void => {
          if (cleanedUp) return;
          cleanedUp = true;
          unsubscribe();
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

        unsubscribe = subscribe("run.status", (payload: Readonly<Record<string, unknown>>): void => {
          const eventOrgId = typeof payload["org-id"] === "string" ? payload["org-id"] : "";
          if (allowedOrgIds !== null && (eventOrgId === "" || !allowedOrgIds.has(eventOrgId))) return;
          enqueue("run.status", payload);
        });

        heartbeat = setInterval((): void => {
          enqueue("ping", { at: new Date().toISOString() });
        }, HEARTBEAT_MS);

        // One-hour lifetime: the allowed-org snapshot ages; closing forces
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
