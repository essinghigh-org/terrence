import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { app } from "../../src/app";
import { publish } from "../../src/lib/event-bus";
import { db } from "../../src/db";
import { organizationMemberships } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import {
  cleanupSeed,
  jsonHeaders,
  persistSeed,
  seedOrg,
} from "./compat_contract_helpers";

const decoder = new TextDecoder();

async function openStream(headers: Record<string, string>): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await app.handle(new Request("http://localhost/api/v2/events", { headers }));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const first = await reader!.read();
  expect(decoder.decode(first.value)).toContain("event: connected");
  return reader!;
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string, attempts = 40): Promise<string> {
  let all = "";
  try {
    for (let i = 0; i < attempts && !all.includes(marker); i += 1) {
      // Race each read against a short timeout so a filtered (silent)
      // stream cannot hang the test; a timeout is NOT a stream end and the
      // loop keeps polling within its attempt budget.
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: false; value: undefined; timedOut: true }>((resolve): void => {
          setTimeout((): void => resolve({ done: false, value: undefined, timedOut: true }), 250);
        }),
      ]);
      if (result.done) break;
      if (result.value !== undefined) all += decoder.decode(result.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch((): void => {});
    reader.releaseLock();
  }
  return all;
}

describe("authenticated SSE event stream (10.20)", () => {
  const seed = seedOrg("events");
  const headers = jsonHeaders(seed.token);

  beforeAll(async () => {
    await persistSeed(seed);
  });

  afterAll(async () => {
    await cleanupSeed(seed);
  });

  it("requires authentication", async () => {
    const response = await app.handle(new Request("http://localhost/api/v2/events"));
    expect(response.status).toBe(401);
  });

  it("streams run.status events to org members", async () => {
    const reader = await openStream(headers);

    publish("run.status", {
      "run-id": "run-sse-1",
      "workspace-id": "ws-sse-1",
      "org-id": seed.orgId,
      status: "planning",
      at: new Date().toISOString(),
    });
    const streamed = await readUntil(reader, "run.status");
    expect(streamed).toContain('"run-id":"run-sse-1"');
    expect(streamed).toContain('"status":"planning"');
  });

  it("drops events for organizations the user does not belong to", async () => {
    const reader = await openStream(headers);

    publish("run.status", {
      "run-id": "run-sse-foreign",
      "workspace-id": "ws-sse-foreign",
      "org-id": "org-not-mine",
      status: "applying",
      at: new Date().toISOString(),
    });
    // The foreign event must never surface; a local event that arrives
    // afterwards proves the stream is alive and was filtered, not stalled.
    publish("run.status", {
      "run-id": "run-sse-local",
      "workspace-id": "ws-sse-2",
      "org-id": seed.orgId,
      status: "planned",
      at: new Date().toISOString(),
    });
    const streamed = await readUntil(reader, "run-sse-local");
    expect(streamed).not.toContain("run-sse-foreign");
    expect(streamed).toContain('"run-id":"run-sse-local"');
  });

  it("relays plan.output.ready with run and plan identifiers", async () => {
    const reader = await openStream(headers);

    publish("plan.output.ready", {
      "run-id": "run-sse-plan",
      "workspace-id": "ws-sse-3",
      "org-id": seed.orgId,
      "plan-id": "plan-run-sse-plan",
    });
    const streamed = await readUntil(reader, "plan.output.ready");
    expect(streamed).toContain('"run-id":"run-sse-plan"');
    expect(streamed).toContain('"plan-id":"plan-run-sse-plan"');
  });

  it("relays comment.created but filters foreign-org comments", async () => {
    const reader = await openStream(headers);

    publish("comment.created", {
      "run-id": "run-sse-comment",
      "workspace-id": "ws-sse-4",
      "org-id": seed.orgId,
      "comment-id": "rc-sse-1",
    });
    publish("comment.created", {
      "run-id": "run-sse-comment-foreign",
      "workspace-id": "ws-sse-foreign-2",
      "org-id": "org-not-mine",
      "comment-id": "rc-sse-foreign",
    });
    const streamed = await readUntil(reader, "rc-sse-1");
    expect(streamed).toContain("comment.created");
    expect(streamed).toContain('"comment-id":"rc-sse-1"');
    expect(streamed).not.toContain("rc-sse-foreign");
  });

  it("closes the stream when authz.changed targets the connected user", async () => {
    const reader = await openStream(headers);

    publish("authz.changed", { "user-id": seed.userId, "org-id": seed.orgId });
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: false; timedOut: true }>((resolve): void => {
        setTimeout((): void => resolve({ done: false, timedOut: true }), 500);
      }),
    ]);
    expect(result.done).toBe(true);
    await reader.cancel().catch((): void => {});
    reader.releaseLock();
  });

  it("keeps the stream open when authz.changed targets another user", async () => {
    const reader = await openStream(headers);

    publish("authz.changed", { "user-id": "user-someone-else", "org-id": seed.orgId });
    publish("run.status", {
      "run-id": "run-sse-after-authz",
      "workspace-id": "ws-sse-5",
      "org-id": seed.orgId,
      status: "planning",
      at: new Date().toISOString(),
    });
    const streamed = await readUntil(reader, "run-sse-after-authz");
    // The stream survived the unrelated authz change and still relays events.
    expect(streamed).toContain('"run-id":"run-sse-after-authz"');
    // authz.changed is a control topic: it must never be relayed to clients.
    expect(streamed).not.toContain("authz.changed");
  });

  it("closes the stream when the user's org membership is deleted via the API", async () => {
    const extraMembershipId = `membership-events-${crypto.randomUUID()}`;
    await db.insert(organizationMemberships).values({
      id: extraMembershipId,
      userId: seed.userId,
      orgId: seed.orgId,
      role: "viewer",
    });
    try {
      const reader = await openStream(headers);
      const response = await app.handle(new Request(
        `http://localhost/api/v2/organization-memberships/${extraMembershipId}`,
        { method: "DELETE", headers },
      ));
      expect(response.status).toBe(204);
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: false; timedOut: true }>((resolve): void => {
          setTimeout((): void => resolve({ done: false, timedOut: true }), 500);
        }),
      ]);
      expect(result.done).toBe(true);
      await reader.cancel().catch((): void => {});
      reader.releaseLock();
    } finally {
      await db.delete(organizationMemberships).where(eq(organizationMemberships.id, extraMembershipId)).catch((): void => {});
    }
  });
});
