import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, users } from "../../src/db/schema";

const suffix = crypto.randomUUID();
const userId = `manifest-admin-${suffix}`;
const token = `manifest-token-${suffix}`;
const tokenHash = createHash("sha256").update(token).digest("hex");

function request(accept = "application/vnd.api+json", query = "", credential = token): Promise<Response> {
  return app.handle(new Request(`http://terrence.test/api/v2/admin/github-app/manifest/setup${query}`, {
    headers: { Authorization: `Bearer ${credential}`, Accept: accept },
  }));
}

async function handoffUrl(query = "", credential = token): Promise<URL> {
  const response = await request("application/vnd.api+json", query, credential);
  expect(response.status).toBe(200);
  const body = await response.json() as { data: { attributes: { "authorization-url": string } } };
  return new URL(body.data.attributes["authorization-url"]);
}

function decodeAttribute(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function form(html: string): { action: URL; manifest: Record<string, unknown> } {
  const action = /<form[^>]*method="post"[^>]*action="([^"]+)"/.exec(html)?.[1];
  const manifest = /name="manifest" value="([^"]*)"/.exec(html)?.[1];
  expect(action).toBeDefined();
  expect(manifest).toBeDefined();
  return { action: new URL(decodeAttribute(action ?? "")), manifest: JSON.parse(decodeAttribute(manifest ?? "")) as Record<string, unknown> };
}

beforeAll(async () => {
  await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused", isSiteAdmin: true }]);
  await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token: tokenHash, userId }]);
});

afterAll(async () => {
  await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

test("JSON:API setup returns a same-origin handoff, not a GitHub GET with a manifest query", async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/vnd.api+json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json() as { data: { attributes: { "authorization-url": string } } };
  const url = new URL(body.data.attributes["authorization-url"]);
  expect(url.pathname).toBe("/api/v2/admin/github-app/manifest/redirect");
  expect(url.searchParams.get("state")).toBeTruthy();
  expect(url.searchParams.has("manifest")).toBe(false);
  // The ordinary SPA/API policy must remain strict.
  expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
});

test("handoff navigation needs no bearer header and posts the preconfigured manifest", async () => {
  const url = await handoffUrl();
  const response = await app.handle(new Request(url, { headers: { Accept: "text/html" } }));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  const { action, manifest } = form(await response.text());
  expect(action.pathname).toBe("/settings/apps/new");
  expect(action.searchParams.get("state")).toBe(url.searchParams.get("state"));
  expect(action.searchParams.has("manifest")).toBe(false);
  expect(manifest["public"]).toBe(false);
  expect(manifest["setup_on_update"]).toBe(true);
  expect(manifest["default_permissions"]).toEqual({ contents: "read", metadata: "read", pull_requests: "read", repository_hooks: "read", statuses: "write" });
  expect(new URL(String(manifest["redirect_url"])).pathname).toBe("/api/v2/admin/github-app/manifest/callback");
  expect(new URL(String(manifest["setup_url"])).pathname).toBe("/api/v2/admin/github-app/manifest/install-callback");
  expect(JSON.stringify(manifest)).not.toContain(token);
  expect(manifest).not.toHaveProperty("private-key");
  expect(manifest).not.toHaveProperty("pem");
});

test("the final response keeps the scoped CSP instead of adding form-action self", async () => {
  const response = await app.handle(new Request(await handoffUrl(), { headers: { Accept: "text/html" } }));
  const html = await response.text();
  const { action } = form(html);
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toContain(`form-action ${action.origin}`);
  expect(csp).not.toContain("form-action 'self'");
  expect(csp).not.toContain("unsafe-inline");
  const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1];
  expect(nonce).toBeDefined();
  expect(csp).toContain(`script-src 'nonce-${nonce}'`);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});

test("organization ownership and public visibility are explicit choices", async () => {
  const response = await app.handle(new Request(await handoffUrl("?organization=essinghigh-org&public=true")));
  const { action, manifest } = form(await response.text());
  expect(action.pathname).toBe("/organizations/essinghigh-org/settings/apps/new");
  expect(manifest["public"]).toBe(true);
});

test("invalid organization input and visibility are rejected before issuing a handoff", async () => {
  expect((await request("application/vnd.api+json", "?organization=https%3A%2F%2Fevil.test")).status).toBe(422);
  expect((await request("application/vnd.api+json", "?public=perhaps")).status).toBe(422);
});

test("a handoff is one-use but its callback state remains available", async () => {
  const url = await handoffUrl();
  expect((await app.handle(new Request(url))).status).toBe(200);
  expect((await app.handle(new Request(url))).status).toBe(400);
  const callback = new URL("/api/v2/admin/github-app/manifest/callback", url);
  callback.searchParams.set("state", url.searchParams.get("state") ?? "");
  const response = await app.handle(new Request(callback));
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("GitHub did not return an app manifest code");
  // Even an invalid callback consumes the state; no conversion request is sent.
  const replay = await app.handle(new Request(callback));
  expect(await replay.text()).toContain("Setup state is missing");
});

test("unknown handoff state and callbacks before submission are rejected", async () => {
  expect((await app.handle(new Request("http://terrence.test/api/v2/admin/github-app/manifest/redirect?state=unknown"))).status).toBe(400);
  const url = await handoffUrl();
  url.pathname = "/api/v2/admin/github-app/manifest/callback";
  expect((await app.handle(new Request(url))).status).toBe(400);
});

test("a revoked initiating token cannot use its handoff", async () => {
  const credential = `manifest-revoked-${crypto.randomUUID()}`;
  const id = crypto.randomUUID();
  await db.insert(apiTokens).values([{ id, token: createHash("sha256").update(credential).digest("hex"), userId }]);
  const url = await handoffUrl("", credential);
  await db.delete(apiTokens).where(eq(apiTokens.id, id));
  expect((await app.handle(new Request(url))).status).toBe(403);
});

test("an expired initiating token cannot use its handoff", async () => {
  const credential = `manifest-expired-${crypto.randomUUID()}`;
  const id = crypto.randomUUID();
  await db.insert(apiTokens).values([{ id, token: createHash("sha256").update(credential).digest("hex"), userId }]);
  const url = await handoffUrl("", credential);
  await db.update(apiTokens).set({ expiresAt: Date.now() - 1 }).where(eq(apiTokens.id, id));
  expect((await app.handle(new Request(url))).status).toBe(403);
});

test("anonymous callers cannot create or resume an administrator setup flow", async () => {
  for (const path of ["setup", "resume"]) {
    expect((await app.handle(new Request(`http://terrence.test/api/v2/admin/github-app/manifest/${path}`))).status).toBe(404);
  }
});

test("HTML Accept setup redirects to the local handoff", async () => {
  const response = await request("text/html");
  expect(response.status).toBe(302);
  expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/api/v2/admin/github-app/manifest/redirect");
});

test("manifest setup still rejects plain application/json Accept with 406", async () => {
  expect((await request("application/json")).status).toBe(406);
});
