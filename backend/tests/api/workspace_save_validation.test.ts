import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { configurationVersions, organizations, workspaces } from "../../src/db/schema";

// Issue #628: bad trigger entries and working directories fail at save;
// the preview endpoint dry-runs patterns against the latest configuration.
const SUFFIX = crypto.randomUUID();
const ORG = "wsval-org-" + SUFFIX;
const WS = "wsval-ws-" + SUFFIX;

let token = "";
let workspaceId = "";
let testDir = "";

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return app.handle(new Request("http://localhost" + path, {
    method,
    headers: {
      ...(token === "" ? {} : { Authorization: "Bearer " + token }),
      ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

async function patchWorkspace(attributes: Record<string, unknown>): Promise<Response> {
  return api("PATCH", "/api/v2/workspaces/" + workspaceId, { data: { type: "workspaces", attributes } });
}

beforeAll(async (): Promise<void> => {
  const reg = await api("POST", "/api/v2/users", {
    data: { type: "users", attributes: { username: "wsval-" + SUFFIX, password: "SuperSecretPassword123!" } },
  });
  expect(reg.status).toBe(201);
  const login = await api("POST", "/api/v2/users/login", {
    data: { attributes: { username: "wsval-" + SUFFIX, password: "SuperSecretPassword123!" } },
  });
  expect(login.status).toBe(200);
  token = ((await login.json()) as { data: { attributes: { token: string } } }).data.attributes.token;
  const orgRes = await api("POST", "/api/v2/organizations", {
    data: { type: "organizations", attributes: { name: ORG, email: "wsval@example.internal" } },
  });
  expect(orgRes.status).toBe(201);
  const wsRes = await api("POST", "/api/v2/organizations/" + ORG + "/workspaces", {
    data: { type: "workspaces", attributes: { name: WS } },
  });
  expect(wsRes.status).toBe(201);
  workspaceId = ((await wsRes.json()) as { data: { id: string } }).data.id;

  testDir = await mkdtemp(join(tmpdir(), "terrence-wsval-"));
  const configDir = join(testDir, "config");
  await mkdir(join(configDir, "terraform", "cluster"), { recursive: true });
  await writeFile(join(configDir, "main.tf"), "terraform {}");
  await writeFile(join(configDir, "terraform", "cluster", "main.tf"), "terraform {}");
  const archivePath = join(testDir, "config.tar.gz");
  const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", configDir, "."]);
  expect(await tar.exited).toBe(0);
  await db.insert(configurationVersions).values({
    id: "wsval-cv-" + SUFFIX,
    workspaceId,
    status: "uploaded",
    archivePath,
  });
});

afterAll(async (): Promise<void> => {
  await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, workspaceId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(organizations).where(eq(organizations.name, ORG));
  if (testDir !== "") await rm(testDir, { recursive: true, force: true });
});

describe("workspace save-time validation (#628)", (): void => {
  test("rejects trigger entries that can never match", async (): Promise<void> => {
    const blank = await patchWorkspace({ "trigger-patterns": ["terraform/**/*.tf", ""] });
    expect(blank.status).toBe(422);
    const blankBody = (await blank.json()) as { errors: { detail: string }[] };
    expect(blankBody.errors[0]?.detail).toContain("trigger-patterns");

    const typed = await patchWorkspace({ "trigger-prefixes": ["terraform", 42] });
    expect(typed.status).toBe(422);

    const valid = await patchWorkspace({ "trigger-patterns": ["terraform/**/*.tf"], "trigger-prefixes": ["terraform"] });
    expect(valid.status).toBe(200);
  });

  test("rejects a working directory matching nothing in the latest configuration", async (): Promise<void> => {
    const good = await patchWorkspace({ "working-directory": "terraform/cluster" });
    expect(good.status).toBe(200);

    const bad = await patchWorkspace({ "working-directory": "elsewhere" });
    expect(bad.status).toBe(422);
    const badBody = (await bad.json()) as { errors: { detail: string }[] };
    expect(badBody.errors[0]?.detail).toContain("elsewhere");
    expect(badBody.errors[0]?.detail).toContain("terraform");
  });

  test("previews trigger patterns against the latest configuration", async (): Promise<void> => {
    await patchWorkspace({ "trigger-patterns": ["terraform/**/*.tf", "nomatch/**/*.tf"] });
    const preview = await api("GET", "/api/v2/workspaces/" + workspaceId + "/trigger-preview");
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as { data: { attributes: {
      "configuration-version-id": string;
      "files-checked": number;
      patterns: { pattern: string; matches: number; "matched-files": string[] }[];
    } } };
    expect(body.data.attributes["files-checked"]).toBeGreaterThan(0);
    const byPattern = new Map(body.data.attributes.patterns.map((entry) => [entry.pattern, entry]));
    expect(byPattern.get("terraform/**/*.tf")?.matches).toBeGreaterThan(0);
    expect(byPattern.get("nomatch/**/*.tf")?.matches).toBe(0);
  });
});
