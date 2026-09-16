const MCP_PROTOCOL_VERSION = "2026-07-28";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Upgrade a JSON-RPC RequestInit to the modern stateless MCP HTTP envelope. */
export function modernMcpInit(init: RequestInit): RequestInit {
  if (typeof init.body !== "string") throw new Error("MCP test requests require a JSON string body");
  const body = record(JSON.parse(init.body) as unknown);
  const method = typeof body["method"] === "string" ? body["method"] : "";
  const params = record(body["params"]);
  const existingMeta = record(params["_meta"]);
  const modernBody = {
    ...body,
    params: {
      ...params,
      _meta: {
        ...existingMeta,
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "terrence-tests", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json, text/event-stream");
  headers.set("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
  headers.set("Mcp-Method", method);
  if (method === "tools/call" && typeof params["name"] === "string") headers.set("Mcp-Name", params["name"]);
  return { ...init, headers, body: JSON.stringify(modernBody) };
}
