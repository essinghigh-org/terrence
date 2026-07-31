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

  it("quotes the URL in the apprise config so `#` channels survive (YAML comment regression)", async () => {
    const port = (server as unknown as { port: number }).port;
    // `#` inside an unquoted YAML scalar starts a comment; a Slack URL like
    // slack://token/#general would be truncated to slack://token/ by the
    // YAML parser. The config writer must quote the URL scalar. Read the
    // written config back to prove the URL is single-quoted.
    const url = `json://127.0.0.1:${port}/hook`;
    const result = await invokeApprise(dest(url), "T", "B", "info");
    expect(result.ok).toBe(true);
    const fs = await import("node:fs");
    const tmpDir = `${process.env.STORAGE_DIR ?? "/tmp"}/apprise-tmp`;
    const written = fs.readFileSync(`${tmpDir}/d-json.yml`, "utf8");
    expect(written).toContain(`  - '${url}'`);
    expect(written).not.toContain(`  - ${url}`);
  });
});
