import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { app } from "../../src/app";
import { allMcpTools } from "../../src/lib/mcp";
import { log } from "../../src/lib/log";
import { MCP_SERVER_INFO_META_KEY } from "../../src/lib/mcp/protocol";
import { MCP_PROTOCOL_VERSION } from "../../src/routes/mcp";
import { cleanupSeed, persistSeed, seedOrg } from "./compat_contract_helpers";

const seed = seedOrg("mcp-modern");
const SERVER_INFO_KEY = MCP_SERVER_INFO_META_KEY;
const PROTOCOL_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";

type SendOptions = Readonly<{
  headerVersion?: string | null;
  bodyVersion?: string | null;
  methodHeader?: string | null;
  nameHeader?: string | null;
  accept?: string | null;
  contentType?: string | null;
  origin?: string | null;
  includeClientInfo?: boolean;
  includeCapabilities?: boolean;
}>;

function body(
  method: string,
  params: Readonly<Record<string, unknown>>,
  id: string | number,
  options: SendOptions,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (options.bodyVersion !== null) meta[PROTOCOL_KEY] = options.bodyVersion ?? MCP_PROTOCOL_VERSION;
  if (options.includeCapabilities !== false) meta[CAPABILITIES_KEY] = {};
  if (options.includeClientInfo !== false) meta[CLIENT_INFO_KEY] = { name: "terrence-modern-tests", version: "1.0.0" };
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } };
}

async function send(
  method: string,
  params: Readonly<Record<string, unknown>> = {},
  options: SendOptions = {},
): Promise<Response> {
  const headers = new Headers({ Authorization: `Bearer ${seed.token}` });
  if (options.contentType !== null) headers.set("Content-Type", options.contentType ?? "application/json");
  if (options.accept !== null) headers.set("Accept", options.accept ?? "application/json, text/event-stream");
  if (options.headerVersion !== null)
    headers.set("MCP-Protocol-Version", options.headerVersion ?? MCP_PROTOCOL_VERSION);
  if (options.methodHeader !== null) headers.set("Mcp-Method", options.methodHeader ?? method);
  if (method === "tools/call" && options.nameHeader !== null) {
    const name = typeof params["name"] === "string" ? params["name"] : "";
    headers.set("Mcp-Name", options.nameHeader ?? name);
  }
  if (options.origin !== null && options.origin !== undefined) headers.set("Origin", options.origin);
  return app.handle(
    new Request("http://terrence.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(body(method, params, 1, options)),
    }),
  );
}

beforeAll(async () => {
  await persistSeed(seed);
});

afterAll(async () => {
  await cleanupSeed(seed);
});

describe("MCP 2026-07-28 modern protocol", () => {
  it("is POST-only and no longer exposes the legacy standalone SSE GET endpoint", async () => {
    const response = await app.handle(
      new Request("http://terrence.test/mcp", {
        headers: { Authorization: `Bearer ${seed.token}` },
      }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("discovers the modern protocol and stamps server identity in result metadata", async () => {
    const response = await send("server/discover");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { result: Record<string, unknown> };
    expect(payload.result["resultType"]).toBe("complete");
    expect(payload.result["supportedVersions"]).toEqual([MCP_PROTOCOL_VERSION]);
    expect(payload.result["capabilities"]).toEqual({ tools: { listChanged: false } });
    expect(payload.result["serverInfo"]).toBeUndefined();
    expect((payload.result["_meta"] as Record<string, unknown>)[SERVER_INFO_KEY]).toMatchObject({
      name: "terrence-mcp",
      version: expect.any(String),
    });
    expect(payload.result["ttlMs"]).toBe(300_000);
    expect(payload.result["cacheScope"]).toBe("private");
  });

  it("allows clientInfo to be omitted while retaining required per-request metadata", async () => {
    const response = await send("server/discover", {}, { includeClientInfo: false });
    expect(response.status).toBe(200);
  });

  it("returns deterministic annotated tools with private cache hints", async () => {
    const response = await send("tools/list");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      result: { tools: { name: string; annotations: Record<string, boolean> }[]; ttlMs: number; cacheScope: string };
    };
    expect(payload.result.ttlMs).toBe(0);
    expect(payload.result.cacheScope).toBe("private");
    const names = payload.result.tools.map((tool): string => tool.name);
    const repeated = await send("tools/list");
    const repeatedPayload = (await repeated.json()) as { result: { tools: { name: string }[] } };
    expect(repeatedPayload.result.tools.map((tool): string => tool.name)).toEqual(names);
    expect(new Set(names).size).toBe(names.length);
    expect(payload.result.tools.find((tool) => tool.name === "list_organizations")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(payload.result.tools.find((tool) => tool.name === "apply_run")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  it("returns complete tool results with both text and structured content", async () => {
    const response = await send("tools/call", { name: "list_organizations", arguments: {} });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { result: Record<string, unknown> };
    expect(payload.result["resultType"]).toBe("complete");
    expect(payload.result["isError"]).toBe(false);
    expect(Array.isArray(payload.result["structuredContent"])).toBe(true);
    expect((payload.result["content"] as { type: string; text: string }[])[0]?.type).toBe("text");
    expect((payload.result["_meta"] as Record<string, unknown>)[SERVER_INFO_KEY]).toMatchObject({
      name: "terrence-mcp",
      version: expect.any(String),
    });
  });

  it("does not expose unexpected tool exception details to clients", async () => {
    const tool = allMcpTools.find((candidate) => candidate.name === "list_organizations");
    expect(tool).toBeDefined();
    if (tool === undefined) return;
    const error = new Error("Internal database details: private_table at db.internal:5432");
    const handlerSpy = spyOn(tool, "handler").mockRejectedValue(error);
    const logSpy = spyOn(log, "error").mockImplementation(() => undefined);
    try {
      const response = await send("tools/call", { name: tool.name, arguments: {} });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Tool execution failed" },
      });
      expect(logSpy).toHaveBeenCalledWith("MCP tool execution failed", {
        toolName: tool.name,
        requestId: 1,
        error,
      });
    } finally {
      handlerSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("accepts the Base64 sentinel encoding for Mcp-Name", async () => {
    const response = await send(
      "tools/call",
      { name: "list_organizations", arguments: {} },
      {
        nameHeader: "=?base64?bGlzdF9vcmdhbml6YXRpb25z?=",
      },
    );
    expect(response.status).toBe(200);
  });

  it("rejects the removed initialize handshake as an unknown modern method", async () => {
    const response = await send("initialize");
    expect(response.status).toBe(404);
    const payload = (await response.json()) as { error: { code: number } };
    expect(payload.error.code).toBe(-32601);
  });

  it("requires the modern request metadata envelope", async () => {
    const response = await send("tools/list", {}, { bodyVersion: null });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: number } };
    expect(payload.error.code).toBe(-32602);
  });

  it("requires client capabilities in every request", async () => {
    const response = await send("tools/list", {}, { includeCapabilities: false });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: number } };
    expect(payload.error.code).toBe(-32602);
  });

  it("rejects mismatched mirrored routing headers with HeaderMismatch", async () => {
    const response = await send("tools/list", {}, { methodHeader: "tools/call" });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: number } };
    expect(payload.error.code).toBe(-32020);
  });

  it("requires Mcp-Name on tool calls", async () => {
    const response = await send("tools/call", { name: "list_organizations", arguments: {} }, { nameHeader: null });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: number } };
    expect(payload.error.code).toBe(-32020);
  });

  it("returns UnsupportedProtocolVersion with the supported revision", async () => {
    const response = await send("tools/list", {}, { headerVersion: "2025-11-25", bodyVersion: "2025-11-25" });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error: { code: number; data: { supported: string[]; requested: string } };
    };
    expect(payload.error.code).toBe(-32022);
    expect(payload.error.data).toEqual({ supported: [MCP_PROTOCOL_VERSION], requested: "2025-11-25" });
  });

  it("rejects disallowed browser origins", async () => {
    const response = await send("tools/list", {}, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
  });

  it("requires both modern Streamable HTTP response media types in Accept", async () => {
    const response = await send("tools/list", {}, { accept: "application/json" });
    expect(response.status).toBe(406);
  });

  it("requires application/json request bodies", async () => {
    const response = await send("tools/list", {}, { contentType: "application/vnd.api+json" });
    expect(response.status).toBe(415);
  });
});
