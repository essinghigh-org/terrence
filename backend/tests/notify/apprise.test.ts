import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { invokeApprise, type NotificationDestination } from "../../src/lib/notify";

// A local HTTP server that records POST bodies — lets us verify a REAL
// delivery through the actual apprise CLI without any external service.
const received: { title?: unknown; message?: unknown }[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll((): void => {
  server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      if (req.method === "POST") {
        try {
          const json = (await req.json()) as { title?: unknown; message?: unknown };
          received.push(json);
        } catch {
          received.push({ message: await req.text() });
        }
      }
      return new Response("ok");
    },
  });
});

afterAll((): void => {
  server?.stop(true);
});

function dest(url: string): NotificationDestination {
  return {
    id: "d-json",
    orgId: "org-1",
    name: "json test",
    type: "apprise-custom",
    config: { url },
    enabled: true,
  };
}

describe("invokeApprise", () => {
  it("delivers via a real apprise CLI invocation to a local server", async () => {
    const port = (server as unknown as { port: number }).port;
    const result = await invokeApprise(
      dest(`json://127.0.0.1:${port}/hook`),
      "Test Title",
      "Test Body",
      "info",
    );
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(received.length).toBeGreaterThan(0);
    const last = received[received.length - 1];
    expect(String(last?.message ?? "")).toContain("Test Body");
  });

  it("fails cleanly on a malformed apprise URL", async () => {
    const result = await invokeApprise(
      dest("not-a-valid-scheme://"),
      "T",
      "B",
      "info",
    );
    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
  });

  it("rejects a destination with no buildable URL", async () => {
    const result = await invokeApprise(
      { ...dest(""), config: {} },
      "T",
      "B",
      "info",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No Apprise URL");
  });
});
