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
  providerIconPath,
  resolveProviderIconUrl,
} from "../../src/lib/provider-icons";

const originalStorageDir = process.env.STORAGE_DIR;
let fixtureDirectory: string | null = null;

function setFixtureStorage(directory: string): void {
  process.env.STORAGE_DIR = directory;
}

async function removeFixtureStorage(): Promise<void> {
  if (fixtureDirectory !== null) await rm(fixtureDirectory, { recursive: true, force: true });
  fixtureDirectory = null;
  if (originalStorageDir === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = originalStorageDir;
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
