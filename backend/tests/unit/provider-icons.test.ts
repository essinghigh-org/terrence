import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { app } from "../../src/app";
import { AvatarService, imgPath, metaPath } from "../../src/lib/avatars";
import {
  batchResolveProviderIconUrls,
  clearProviderIconCache,
  normalizeProvider,
  primeProviderIconCache,
  providerIconFallbackSvg,
  providerIconPath,
  resolveProviderIconUrl,
} from "../../src/lib/provider-icons";

const originalStorageDir = process.env["STORAGE_DIR"];
let fixtureDirectory: string | null = null;

function setFixtureStorage(directory: string): void {
  process.env["STORAGE_DIR"] = directory;
}

async function removeFixtureStorage(): Promise<void> {
  if (fixtureDirectory !== null) await rm(fixtureDirectory, { recursive: true, force: true });
  fixtureDirectory = null;
  if (originalStorageDir === undefined) delete process.env["STORAGE_DIR"];
  else process.env["STORAGE_DIR"] = originalStorageDir;
}

afterEach(async (): Promise<void> => {
  clearProviderIconCache();
  await removeFixtureStorage();
});

test("preserves provider sources without inventing namespaces or registries", async () => {
  expect(normalizeProvider("registry.terraform.io/cloudflare/cloudflare")).toBe("registry.terraform.io/cloudflare/cloudflare");
  expect(normalizeProvider("cloudflare/cloudflare")).toBe("cloudflare/cloudflare");
  expect(normalizeProvider("registry.terraform.io/integrations/github")).toBe("registry.terraform.io/integrations/github");
  expect(normalizeProvider("acme/widgets")).toBe("acme/widgets");
  expect(normalizeProvider("registry.opentofu.org/acme/widgets")).toBe("registry.opentofu.org/acme/widgets");
  expect(normalizeProvider("cloudflare")).toBeNull();
  expect(normalizeProvider("https://registry.terraform.io/cloudflare/cloudflare")).toBeNull();
  expect(normalizeProvider("registry.terraform.io//cloudflare/cloudflare")).toBeNull();
  expect(normalizeProvider("cloudflare//cloudflare")).toBeNull();
  expect(providerIconPath("acme/widgets")).toBe("/api/v2/provider-icons/registry.terraform.io/acme/widgets");
  expect(providerIconPath("registry.opentofu.org/acme/widgets")).toBeNull();

  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    fetches += 1;
    throw new Error("OpenTofu sources must not use the Terraform Registry");
  }) as unknown as typeof fetch;
  try {
    expect(await resolveProviderIconUrl("registry.opentofu.org/acme/widgets")).toBeNull();
    expect(fetches).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps Cloudflare, GitHub, and TFE icon cache entries independent", async () => {
  primeProviderIconCache("registry.terraform.io/cloudflare/cloudflare", "/api/v2/avatars/cloudflare");
  primeProviderIconCache("registry.terraform.io/integrations/github", "/api/v2/avatars/github");
  primeProviderIconCache("registry.terraform.io/hashicorp/tfe", "/api/v2/avatars/tfe");

  const mapping = await batchResolveProviderIconUrls([
    "registry.terraform.io/cloudflare/cloudflare",
    "registry.terraform.io/integrations/github",
    "registry.terraform.io/hashicorp/tfe",
  ]);

  expect(mapping).toEqual({
    "registry.terraform.io/cloudflare/cloudflare": "/api/v2/avatars/cloudflare",
    "registry.terraform.io/integrations/github": "/api/v2/avatars/github",
    "registry.terraform.io/hashicorp/tfe": "/api/v2/avatars/tfe",
  });
});

test("returns dedicated provider-icon URLs instead of generic avatar URLs", async () => {
  primeProviderIconCache("cloudflare/cloudflare", "/api/v2/avatars/cloudflare");
  primeProviderIconCache("integrations/github", "/api/v2/avatars/github");
  primeProviderIconCache("hashicorp/tfe", "/api/v2/avatars/tfe");

  const response = await app.handle(new Request(
    "http://terrence.test/api/v2/provider-icons?provider-name=cloudflare%2Fcloudflare&provider-name=integrations%2Fgithub&provider-name=hashicorp%2Ftfe",
  ));
  expect(response.status).toBe(200);
  const body = await response.json() as {
    data: { id: string; attributes: { "icon-url": string | null } }[];
  };
  expect(body.data.map((item): string => item.id)).toEqual([
    "cloudflare/cloudflare",
    "integrations/github",
    "hashicorp/tfe",
  ]);
  expect(body.data.map((item): string | null => item.attributes["icon-url"])).toEqual([
    "/api/v2/provider-icons/registry.terraform.io/cloudflare/cloudflare",
    "/api/v2/provider-icons/registry.terraform.io/integrations/github",
    "/api/v2/provider-icons/registry.terraform.io/hashicorp/tfe",
  ]);
  expect(body.data.every((item): boolean => !item.attributes["icon-url"]?.includes("/api/v2/avatars/"))).toBeTrue();
});

test("resolves exact provider artwork through the Terraform Registry v2 API", async () => {
  fixtureDirectory = await mkdtemp(join("/tmp", "terrence-provider-icons-"));
  setFixtureStorage(fixtureDirectory);

  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  const expectedArtworkUrl = "https://registry.terraform.io/images/providers/cloudflare.svg";
  const expectedAvatarKey = AvatarService.cacheKey("provider-icon", expectedArtworkUrl);
  globalThis.fetch = (async (input: string | Request): Promise<Response> => {
    const requestUrl = typeof input === "string" ? input : input.url;
    requestedUrls.push(requestUrl);
    const parsed = new URL(requestUrl);
    expect(parsed.pathname).toBe("/v2/providers");
    expect(parsed.searchParams.get("filter[namespace]")).toBe("cloudflare");
    expect(parsed.searchParams.get("filter[name]")).toBe("cloudflare");
    return new Response(JSON.stringify({
      data: [
        {
          attributes: {
            namespace: "other",
            name: "cloudflare",
            "full-name": "other/cloudflare",
            "logo-url": "https://registry.terraform.io/images/providers/wrong.svg",
          },
        },
        {
          attributes: {
            namespace: "cloudflare",
            name: "cloudflare",
            "full-name": "cloudflare/cloudflare",
            "logo-url": "images/providers/cloudflare.svg",
          },
        },
      ],
    }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
  }) as unknown as typeof fetch;

  try {
    const avatarUrl = await resolveProviderIconUrl("registry.terraform.io/cloudflare/cloudflare");
    expect(avatarUrl).toBe(`/api/v2/avatars/${expectedAvatarKey}`);
    const metadata = await AvatarService.readMeta(expectedAvatarKey);
    expect(metadata?.url).toBe(expectedArtworkUrl);
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).not.toContain("/v1/providers/");

    const response = await app.handle(new Request(
      "http://terrence.test/api/v2/provider-icons?provider-name=registry.terraform.io%2Fcloudflare%2Fcloudflare",
    ));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      data: { attributes: { "icon-url": string | null } }[];
    };
    expect(body.data[0]?.attributes["icon-url"]).toBe(
      `/api/v2/provider-icons/registry.terraform.io/cloudflare/cloudflare?v=${expectedAvatarKey}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolves legacy GitHub slug artwork through the Registry owner avatar", async () => {
  fixtureDirectory = await mkdtemp(join("/tmp", "terrence-provider-icons-"));
  setFixtureStorage(fixtureDirectory);

  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  const expectedArtworkUrl = "https://avatars.githubusercontent.com/u/314135?v=4";
  const expectedAvatarKey = AvatarService.cacheKey("provider-icon", expectedArtworkUrl);
  globalThis.fetch = (async (input: string | Request): Promise<Response> => {
    const requestUrl = typeof input === "string" ? input : input.url;
    requestedUrls.push(requestUrl);
    const parsed = new URL(requestUrl);
    if (parsed.pathname === "/v2/providers") {
      expect(parsed.searchParams.get("filter[namespace]")).toBe("cloudflare");
      expect(parsed.searchParams.get("filter[name]")).toBe("cloudflare");
      return new Response(JSON.stringify({
        data: [{
          attributes: {
            namespace: "cloudflare",
            name: "cloudflare",
            "full-name": "cloudflare/cloudflare",
            "logo-url": "https://avatars3.githubusercontent.com/cloudflare",
          },
        }],
      }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
    }
    expect(parsed.pathname).toBe("/github/users/cloudflare");
    return new Response(JSON.stringify({
      login: "cloudflare",
      avatar_url: expectedArtworkUrl,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  try {
    const avatarUrl = await resolveProviderIconUrl("registry.terraform.io/cloudflare/cloudflare");
    expect(avatarUrl).toBe(`/api/v2/avatars/${expectedAvatarKey}`);
    const metadata = await AvatarService.readMeta(expectedAvatarKey);
    expect(metadata?.url).toBe(expectedArtworkUrl);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]).not.toContain("/v1/providers/");
    expect(requestedUrls[1]).toBe("https://registry.terraform.io/github/users/cloudflare");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not use a legacy GitHub slug when the Registry owner lookup fails", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: string | Request): Promise<Response> => {
    const requestUrl = typeof input === "string" ? input : input.url;
    requestedUrls.push(requestUrl);
    const parsed = new URL(requestUrl);
    if (parsed.pathname === "/v2/providers") {
      return new Response(JSON.stringify({
        data: [{
          attributes: {
            namespace: "cloudflare",
            name: "cloudflare",
            "full-name": "cloudflare/cloudflare",
            "logo-url": "https://avatars3.githubusercontent.com/cloudflare",
          },
        }],
      }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
    }
    expect(parsed.pathname).toBe("/github/users/cloudflare");
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;

  try {
    expect(await resolveProviderIconUrl("registry.terraform.io/cloudflare/cloudflare")).toBeNull();
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls.every((url): boolean => !url.includes("/v1/providers/"))).toBeTrue();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns no artwork when the v2 response has no exact provider identity", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: string | Request): Promise<Response> => {
    const requestUrl = typeof input === "string" ? input : input.url;
    requestedUrls.push(requestUrl);
    return new Response(JSON.stringify({
      data: [{
        attributes: {
          namespace: "other",
          name: "widgets",
          "full-name": "other/widgets",
          "logo-url": "/images/providers/wrong.svg",
        },
      }],
    }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
  }) as unknown as typeof fetch;

  try {
    expect(await resolveProviderIconUrl("registry.terraform.io/acme/widgets")).toBeNull();
    expect(requestedUrls).toHaveLength(1);
    const parsed = new URL(requestedUrls[0]!);
    expect(parsed.pathname).toBe("/v2/providers");
    expect(parsed.searchParams.get("filter[namespace]")).toBe("acme");
    expect(parsed.searchParams.get("filter[name]")).toBe("widgets");
    expect(requestedUrls[0]).not.toContain("/v1/providers/");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("serves cached artwork through the provider-icon image route", async () => {
  fixtureDirectory = await mkdtemp(join("/tmp", "terrence-provider-icons-"));
  setFixtureStorage(fixtureDirectory);

  const sourceUrl = "https://registry.terraform.io/images/providers/cloudflare.svg";
  const key = AvatarService.cacheKey("provider-icon", sourceUrl);
  const bytes = Buffer.from("provider-icon-fixture");
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  await mkdir(join(fixtureDirectory, "avatars", key.slice(0, 2)), { recursive: true });
  await writeFile(metaPath(key), JSON.stringify({
    key,
    providerId: "provider-icon",
    url: sourceUrl,
    state: "fetched",
    contentType: "image/svg+xml",
    etag: null,
    lastModified: null,
    fetchedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    bytes: bytes.byteLength,
    contentHash,
  }));
  await writeFile(imgPath(key), bytes);
  primeProviderIconCache("cloudflare/cloudflare", `/api/v2/avatars/${key}`);

  const response = await app.handle(new Request(
    "http://terrence.test/api/v2/provider-icons/registry.terraform.io/cloudflare/cloudflare",
  ));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/svg+xml");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
});

test("serves a deterministic fallback while registry discovery runs in the background", async () => {
  const originalFetch = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    requests++;
    await gate;
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  try {
    const expected = providerIconFallbackSvg("acme/widgets");
    if (expected === null) throw new Error("Expected a provider fallback fixture");
    const response = await app.handle(new Request(
      "http://terrence.test/api/v2/provider-icons/registry.terraform.io/acme/widgets",
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("etag")).toBe(expected.etag);
    expect(await response.text()).toBe(expected.body);
    await Bun.sleep(0);
    expect(requests).toBe(1);
  } finally {
    release();
    await Bun.sleep(0);
    globalThis.fetch = originalFetch;
  }
});

test("a distinct-source flood stays bounded, deduplicates canonical names, and preserves cached icons", async () => {
  const { discoveryStats } = await import("../../src/lib/discovery-queue");
  const originalFetch = globalThis.fetch;
  const before = discoveryStats();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    await gate;
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  primeProviderIconCache("cached/icon", "/api/v2/avatars/" + "a".repeat(64));
  const pending = Array.from({ length: 5000 }, (_, i) => resolveProviderIconUrl(`flood/icon${i}`));
  const duplicate = resolveProviderIconUrl("registry.terraform.io/flood/icon0");
  try {
    await Bun.sleep(0);
    expect(discoveryStats()).toMatchObject({ active: 2, queued: 30, rejected: before.rejected + 4968 });
    expect(fetches).toBe(2);
    if (process.env["DISCOVERY_LOAD"] === "1") console.log("DISCOVERY_LOAD_RESULT " + JSON.stringify({ requests: 5000, ...discoveryStats(), kernelPeakRss: process.resourceUsage().maxRSS * 1024 }));
    expect(await resolveProviderIconUrl("cached/icon")).toBe("/api/v2/avatars/" + "a".repeat(64));
  } finally {
    release();
    await Promise.all([...pending, duplicate]);
    globalThis.fetch = originalFetch;
  }
  expect(fetches).toBe(32);
  expect(await resolveProviderIconUrl("cached/icon")).toBe("/api/v2/avatars/" + "a".repeat(64));
});

test("bounds pending avatar records while preserving existing metadata", async () => {
  fixtureDirectory = await mkdtemp("/tmp/terrence-avatar-admission-");
  setFixtureStorage(fixtureDirectory);
  const cached = AvatarService.resolveUrl("probe", "https://example.com/cached.png");
  expect(cached).not.toBeNull();
  await AvatarService.readMeta(cached?.split("/").at(-1) ?? "");
  const admitted = Array.from({ length: 1000 }, (_, i) => AvatarService.resolveUrl("probe", `https://example.com/icon-${i}.png`)).filter((value): value is string => value !== null);
  expect(admitted).toHaveLength(128);
  expect(AvatarService.resolveUrl("probe", "https://example.com/cached.png")).toBe(cached);
  await Promise.all(admitted.map(async (url) => AvatarService.readMeta(url.split("/").at(-1) ?? "")));
});

test("rejects oversized registry metadata and negatively caches the failure", async () => {
  const originalFetch = globalThis.fetch;
  let canceled = false;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel() { canceled = true; },
    }));
  }) as unknown as typeof fetch;
  try {
    expect(await resolveProviderIconUrl("oversized/icon")).toBeNull();
    expect(canceled).toBe(true);
    expect(await resolveProviderIconUrl("oversized/icon")).toBeNull();
    expect(requests).toBe(1);
  } finally { globalThis.fetch = originalFetch; }
});
