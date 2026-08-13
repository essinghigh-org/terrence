import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { app } from "../../src/app";
import { publish } from "../../src/lib/event-bus";
import {
  cleanupSeed,
  jsonHeaders,
  persistSeed,
  seedTfeOrg,
} from "./tfe_contract_helpers";

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
  const seed = seedTfeOrg("events");
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
});
