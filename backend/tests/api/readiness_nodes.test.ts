import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { app, systemApiApp } from "../../src/app";
import { db } from "../../src/db";
import { controlPlaneNodes, systemApiTokens } from "../../src/db/schema";
import { HA_PROTOCOL_VERSION } from "../../src/lib/ha-protocol";
import { hashSystemApiToken } from "../../src/lib/system-api";

const createdTokenIds: string[] = [];
const createdNodeIds: string[] = [];

// The System API rate-limits at one request/second per token (matching the reference format), so
// each test seeds and uses its own system token to avoid 429s.
async function seedSystemToken(): Promise<string> {
  const systemToken = `tfe-system-${crypto.randomUUID()}`;
  const id = `sys-token-${crypto.randomUUID()}`;
  createdTokenIds.push(id);
  await db.insert(systemApiTokens).values({
    id,
    tokenHash: hashSystemApiToken(systemToken),
    description: "readiness parity test",
    expiresAt: Date.now() + 7_200_000,
  });
  return systemToken;
}

async function systemRequest(
  path: string,
  options: Readonly<{ method?: string; body?: unknown }> = {},
): Promise<Response> {
  const systemToken = await seedSystemToken();
  return systemApiApp.handle(
    new Request(`http://terrence.test${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${systemToken}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
}

async function seedRemoteNode(
  options: Readonly<{ protocolVersion: number | null; heartbeatAt?: number }> = {
    protocolVersion: HA_PROTOCOL_VERSION,
  },
): Promise<string> {
  const id = `ha-drain-node-${crypto.randomUUID()}`;
  const heartbeatAt = options.heartbeatAt ?? Date.now();
  createdNodeIds.push(id);
  await db.insert(controlPlaneNodes).values({
    id,
    hostname: id,
    instanceId: `instance-${crypto.randomUUID()}`,
    role: "follower",
    status: "active",
    version: "1.5.0",
    protocolVersion: options.protocolVersion,
    minProtocolVersion: options.protocolVersion === null ? null : 1,
    readinessChecks: [],
    registeredAt: heartbeatAt,
    lastHeartbeatAt: heartbeatAt,
  });
  return id;
}

describe("Readiness & Nodes API (the reference format Parity)", () => {
  test("GET /api/v1/nodes returns typed node resources in data", async () => {
    const systemToken = await seedSystemToken();
    const res = await app.handle(
      new Request("http://localhost/api/v1/nodes", {
        method: "GET",
        headers: { Authorization: `Bearer ${systemToken}` },
      }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();

    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data[0]).toEqual({ id: "terrence-node-1", type: "nodes" });
  });
  test("remote HA-3 drain reports the target phase and preserves heartbeat ownership", async () => {
    const heartbeatAt = Date.now() - 2_000;
    const nodeId = await seedRemoteNode({ protocolVersion: HA_PROTOCOL_VERSION, heartbeatAt });

    const drained = await systemRequest(`/api/v1/nodes/${nodeId}/drain`, {
      method: "POST",
      body: { data: { type: "node-drains", attributes: { reason: "rolling replacement" } } },
    });
    expect(drained.status).toBe(200);
    const drainedBody = await drained.json();
    expect(drainedBody.data).toMatchObject({
      id: nodeId,
      type: "node-drains",
      attributes: { phase: "draining", reason: "rolling replacement" },
    });

    const row = await db.query.controlPlaneNodes.findFirst({
      where: inArray(controlPlaneNodes.id, [nodeId]),
    });
    expect(row?.status).toBe("maintenance");
    expect(row?.drainRequestedAt).not.toBeNull();
    expect(row?.lastHeartbeatAt).toBe(heartbeatAt);

    const readiness = await systemRequest("/api/v1/nodes/readiness");
    expect(readiness.status).toBe(200);
    const readinessBody = await readiness.json();
    const remote = (readinessBody.data as { id: string; attributes: Record<string, unknown> }[]).find(
      (node) => node.id === nodeId,
    );
    expect(remote?.attributes).toMatchObject({ status: "DRAINING", "drain-phase": "draining" });

    const uncordoned = await systemRequest(`/api/v1/nodes/${nodeId}/drain`, { method: "DELETE" });
    expect(uncordoned.status).toBe(200);
    expect((await uncordoned.json()).data).toMatchObject({
      id: nodeId,
      type: "node-drains",
      attributes: { phase: "active" },
    });

    const active = await db.query.controlPlaneNodes.findFirst({
      where: inArray(controlPlaneNodes.id, [nodeId]),
    });
    expect(active?.status).toBe("active");
    expect(active?.drainRequestedAt).toBeNull();
    expect(active?.lastHeartbeatAt).toBe(heartbeatAt);
  });

  test("remote drain rejects a live pre-HA3 node instead of recording ignored intent", async () => {
    const nodeId = await seedRemoteNode({ protocolVersion: null });

    const response = await systemRequest(`/api/v1/nodes/${nodeId}/drain`, {
      method: "POST",
      body: { data: { type: "node-drains", attributes: { reason: "rolling replacement" } } },
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.errors?.[0]).toMatchObject({ status: "409", title: "Conflict" });

    const row = await db.query.controlPlaneNodes.findFirst({
      where: inArray(controlPlaneNodes.id, [nodeId]),
    });
    expect(row?.status).toBe("active");
    expect(row?.drainRequestedAt).toBeNull();
  });

  test("GET /api/v1/nodes/readiness returns typed node resources", async () => {
    const systemToken = await seedSystemToken();
    const res = await app.handle(
      new Request("http://localhost/api/v1/nodes/readiness", {
        method: "GET",
        headers: { Authorization: `Bearer ${systemToken}` },
      }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.data)).toBe(true);
    const local = (json.data as { id: string; type: string; attributes: Record<string, unknown> }[]).find(
      (node) => node.id === "terrence-node-1",
    );
    expect(local?.type).toBe("nodes");
    expect(local?.attributes["status"]).toBe("OK");
    expect(Array.isArray(local?.attributes["checks"])).toBe(true);
  });

  test("GET /api/v1/health/readiness returns subsystem health status", async () => {
    const systemToken = await seedSystemToken();
    const res = await app.handle(
      new Request("http://localhost/api/v1/health/readiness", {
        method: "GET",
        headers: { Authorization: `Bearer ${systemToken}` },
      }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("OK");
    expect(Array.isArray(json.checks)).toBe(true);
    // SEC-10: the effective run network policy is a first-class check, so a
    // requested TCP denial that cannot be installed never reads as healthy.
    const netCheck = (json.checks as { check: string; status: string }[]).find((c) => c.check === "run-network-policy");
    expect(netCheck?.status).toBe("OK");
  });

  afterAll(async () => {
    if (createdTokenIds.length > 0) {
      await db.delete(systemApiTokens).where(inArray(systemApiTokens.id, createdTokenIds));
    }
    if (createdNodeIds.length > 0) {
      await db.delete(controlPlaneNodes).where(inArray(controlPlaneNodes.id, createdNodeIds));
    }
  });
});
