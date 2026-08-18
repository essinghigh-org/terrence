#!/usr/bin/env bun

const HELP = `Usage: tfectl <command> [options]

Commands:
  admin api-token generate --description <text> [--ttl <hours>]
  admin api-token list
  admin api-token revoke --id <token-id>
  admin usage-report
  node list
  app health readiness [--timeout <1-30>] [--json]
  app diagnostics [--timeout <1-300>] [--check <list>] [--node <id> | --all] [--json]
  app version
  support bundle [--node <id> | --all] [--json]

Environment:
  TFE_ADDRESS          Application API address (default: http://localhost:3000)
  TFE_TOKEN            Site-admin application token for admin commands
  TFE_SYSTEM_ADDRESS   System API address (default: application host on port 8443)
  TFE_SYSTEM_TOKEN     Dedicated System API token
`;

const args = Bun.argv.slice(2);

function takeOption(name: string): string | undefined {
  const equals = args.findIndex((arg): boolean => arg.startsWith(`${name}=`));
  if (equals >= 0) return args.splice(equals, 1)[0]?.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}


function assertNoExtraArgs(): void {
  if (args.length > 0) throw new Error(`unknown option: ${args[0] ?? ""}`);
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function normalizedAddress(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.hostname === "") throw new Error(`invalid address: ${value}`);
  return url.toString().replace(/\/$/, "");
}

function defaultSystemAddress(applicationAddress: string): string {
  const url = new URL(applicationAddress);
  url.port = "8443";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

const applicationAddress = normalizedAddress(takeOption("--address") ?? process.env.TFE_ADDRESS ?? "http://localhost:3000");
const systemAddress = normalizedAddress(takeOption("--system-address") ?? process.env.TFE_SYSTEM_ADDRESS ?? defaultSystemAddress(applicationAddress));
const applicationToken = takeOption("--token") ?? process.env.TFE_TOKEN;
const systemToken = takeOption("--system-token") ?? process.env.TFE_SYSTEM_TOKEN;
const jsonOutput = takeFlag("--json");

async function request(base: string, path: string, token: string | undefined, init: RequestInit = {}): Promise<unknown> {
  if (token === undefined || token === "") throw new Error(`missing ${base === systemAddress ? "TFE_SYSTEM_TOKEN" : "TFE_TOKEN"}`);
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/vnd.api+json" }),
      ...init.headers,
    },
  });
  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  const body: unknown = contentType.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    const errors = body !== null && typeof body === "object" && Array.isArray((body as Record<string, unknown>).errors)
      ? (body as { errors: { detail?: string; title?: string }[] }).errors
      : [];
    throw new Error(errors[0]?.detail ?? errors[0]?.title ?? `request failed with HTTP ${response.status}`);
  }
  return body;
}

function print(value: unknown): void {
  if (typeof value === "string") {
    console.log(value);
    return;
  }
  console.log(jsonOutput ? JSON.stringify(value, null, 2) : JSON.stringify(value));
}

async function main(): Promise<void> {
  if (args.length === 0 || takeFlag("-h") || takeFlag("--help")) {
    console.log(HELP);
    return;
  }
  if (takeFlag("-v") || takeFlag("--version")) {
    console.log("tfectl 2.0.0-compatible");
    return;
  }

  const commandLength = args[0] === "admin" && args[1] === "api-token"
    ? 3
    : args[0] === "app" && args[1] === "health"
      ? 3
      : 2;
  const command = args.splice(0, commandLength).join(" ");
  if (command === "admin api-token generate") {
    const description = takeOption("--description");
    if (description === undefined || description.trim() === "") throw new Error("--description is required");
    const ttl = boundedInteger(takeOption("--ttl"), 720, 1, 8760, "--ttl");
    const body = await request(applicationAddress, "/api/v2/admin/system-api-tokens", applicationToken, {
      method: "POST",
      body: JSON.stringify({ data: { type: "system-api-tokens", attributes: { description, ttl } } }),
    });
    assertNoExtraArgs();
    print(body);
    return;
  }
  if (command === "admin api-token list") {
    assertNoExtraArgs();
    print(await request(applicationAddress, "/api/v2/admin/system-api-tokens", applicationToken));
    return;
  }
  if (command === "admin api-token revoke") {
    const id = takeOption("--id");
    if (id === undefined || id === "") throw new Error("--id is required");
    assertNoExtraArgs();
    await request(applicationAddress, `/api/v2/admin/system-api-tokens/${encodeURIComponent(id)}`, applicationToken, { method: "DELETE" });
    console.log(`Revoked ${id}`);
    return;
  }
  if (command.startsWith("admin usage-report")) {
    assertNoExtraArgs();
    print(await request(systemAddress, "/api/v1/usage/bundle", systemToken));
    return;
  }
  if (command.startsWith("node list")) {
    assertNoExtraArgs();
    print(await request(systemAddress, "/api/v1/nodes", systemToken));
    return;
  }
  if (command === "app health readiness") {
    const timeout = boundedInteger(takeOption("--timeout"), 1, 1, 30, "--timeout");
    assertNoExtraArgs();
    print(await request(systemAddress, `/api/v1/readiness?timeout=${timeout}`, systemToken));
    return;
  }
  if (command.startsWith("app diagnostics")) {
    const timeout = boundedInteger(takeOption("--timeout"), 30, 1, 300, "--timeout");
    const check = takeOption("--check");
    const node = takeOption("--node");
    const all = takeFlag("--all");
    if (node !== undefined && all) throw new Error("--node and --all are mutually exclusive");
    const query = new URLSearchParams({ timeout: String(timeout) });
    if (check !== undefined) query.set("check", check);
    if (node !== undefined) query.set("nodes", node);
    assertNoExtraArgs();
    print(await request(systemAddress, `/api/v1/diagnostics?${query}`, systemToken));
    return;
  }
  if (command.startsWith("app version")) {
    assertNoExtraArgs();
    print(await request(systemAddress, "/api/v1/metadata", systemToken));
    return;
  }
  if (command.startsWith("support bundle")) {
    const node = takeOption("--node");
    const all = takeFlag("--all");
    if (node !== undefined && all) throw new Error("--node and --all are mutually exclusive");
    const data = all ? { all: true } : node === undefined ? {} : { nodes: [node] };
    print(await request(systemAddress, "/api/v1/support/bundle-requests", systemToken, {
      method: "POST",
      body: JSON.stringify(data),
    }));
    return;
  }
  throw new Error(`unknown command\n\n${HELP}`);
}

await main().catch((error: unknown): never => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
