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
let activeConnections = 0;

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

    // Allowed orgs resolved once: site admins see everything; org tokens see
    // their org; users see their memberships.
    let allowedOrgIds: Set<string> | null = null;
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

    // Shared across start()/cancel(): the stream's lifecycle must release
    // the subscription and the connection slot exactly once from either the
    // request abort signal or a client-side reader cancel.
    let unsubscribe: () => void = (): void => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let cleanup: () => void = (): void => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>) {
        activeConnections += 1;
        let cleanedUp = false;
        cleanup = (): void => {
          if (cleanedUp) return;
          cleanedUp = true;
          unsubscribe();
          if (heartbeat !== undefined) clearInterval(heartbeat);
          activeConnections = Math.max(0, activeConnections - 1);
        };
        controller.enqueue(sseFrame("connected", { heartbeatMs: HEARTBEAT_MS }));

        unsubscribe = subscribe("run.status", (payload: Readonly<Record<string, unknown>>): void => {
          const eventOrgId = typeof payload["org-id"] === "string" ? payload["org-id"] : "";
          if (allowedOrgIds !== null && (eventOrgId === "" || !allowedOrgIds.has(eventOrgId))) return;
          try {
            controller.enqueue(sseFrame("run.status", payload));
          } catch {
            // The stream closed under us; stop relaying.
            cleanup();
          }
        });

        heartbeat = setInterval((): void => {
          try {
            controller.enqueue(sseFrame("ping", { at: new Date().toISOString() }));
          } catch {
            cleanup();
          }
        }, HEARTBEAT_MS);

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
