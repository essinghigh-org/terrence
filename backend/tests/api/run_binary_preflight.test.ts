import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { app } from "../../src/app";
import { availableVersions, closestKnownVersion, installedBinaryVersions, knownAvailableVersions } from "../../src/binaryManager";
import { validTarGzip } from "./test-archives";

// Issue #602: run creation preflights an exact pinned version against the
// local binary cache and the known release list, failing fast with the
// closest known version instead of failing mid-run.
const originalFetch = globalThis.fetch;

// Every terraform version other suites pin on runs or workspaces. Seeding the
// shared in-memory discovery cache with this inclusive list keeps those
// suites green regardless of file execution order.
const KNOWN_TERRAFORM = [
  "1.2.3",
  "1.5.7",
  "1.6.0",
  "1.8.0",
  "1.8.5",
  "1.9.0",
  "1.9.3",
  "1.9.5",
  "1.10.0",
  "1.12.1",
  "1.15.0",
];

beforeAll(async (): Promise<void> => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://releases.hashicorp.com/terraform/index.json") {
      const versions: Record<string, Record<string, never>> = {};
      for (const version of KNOWN_TERRAFORM) versions[version] = {};
      return new Response(JSON.stringify({ versions }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as unknown as typeof fetch;
  // Seed the module-level discovery cache (memory + persisted file) so the
  // preflight has affirmative knowledge without touching the network.
  await availableVersions("terraform");
});

afterAll((): void => {
  globalThis.fetch = originalFetch;
});

async function authHeaders(): Promise<Record<string, string>> {
  const suffix = crypto.randomUUID();
  const username = `preflight_${suffix}`;
  const password = "SuperSecretPassword123!";
  const regRes = await app.handle(
    new Request("http://localhost/api/v2/users", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: { type: "users", attributes: { username, password, email: `${username}@example.com` } },
      }),
    }),
  );
  expect(regRes.status).toBe(201);
  const loginRes = await app.handle(
    new Request("http://localhost/api/v2/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({ data: { attributes: { username, password } } }),
    }),
  );
  expect(loginRes.status).toBe(200);
  const token = (await loginRes.json()).data.attributes.token as string;
  return { Authorization: "Bearer " + token, "Content-Type": "application/vnd.api+json" };
}

async function setupWorkspace(headers: Record<string, string>, terraformVersion?: string): Promise<{ workspaceId: string; cvId: string }> {
  const suffix = crypto.randomUUID();
  const orgRes = await app.handle(
    new Request("http://localhost/api/v2/organizations", {
      method: "POST",
      headers,
      body: JSON.stringify({
        data: { type: "organizations", attributes: { name: `preflight-org-${suffix}`, email: "admin@example.internal" } },
      }),
    }),
  );
  expect(orgRes.status).toBe(201);
  const orgName = `preflight-org-${suffix}`;
  const wsRes = await app.handle(
    new Request(`http://localhost/api/v2/organizations/${orgName}/workspaces`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        data: {
          type: "workspaces",
          attributes: {
            name: `preflight-ws-${suffix}`,
            "iac-binary": "terraform",
            ...(terraformVersion === undefined ? {} : { "terraform-version": terraformVersion }),
          },
        },
      }),
    }),
  );
  expect(wsRes.status).toBe(201);
  const workspaceId = (await wsRes.json()).data.id as string;
  const cvRes = await app.handle(
    new Request(`http://localhost/api/v2/workspaces/${workspaceId}/configuration-versions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        data: { type: "configuration-versions", attributes: { auto_queue_runs: false, speculative: false } },
      }),
    }),
  );
  expect(cvRes.status).toBe(201);
  const cvId = (await cvRes.json()).data.id as string;
  const uploadRes = await app.handle(
    new Request(`http://localhost/api/v2/configuration-versions/${cvId}/upload`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/octet-stream" },
      body: validTarGzip("preflight"),
    }),
  );
  expect(uploadRes.status).toBe(200);
  return { workspaceId, cvId };
}

async function createRun(
  headers: Record<string, string>,
  workspaceId: string,
  cvId: string,
  terraformVersion?: string,
): Promise<Response> {
  return app.handle(
    new Request("http://localhost/api/v2/runs", {
      method: "POST",
      headers,
      body: JSON.stringify({
        data: {
          type: "runs",
          attributes: {
            message: "Preflight check run",
            ...(terraformVersion === undefined ? {} : { "terraform-version": terraformVersion }),
          },
          relationships: {
            workspace: { data: { id: workspaceId, type: "workspaces" } },
            "configuration-version": { data: { id: cvId, type: "configuration-versions" } },
          },
        },
      }),
    }),
  );
}

describe("run creation binary preflight (#602)", (): void => {
  test("rejects an unknown exact version naming the closest known one", async (): Promise<void> => {
    const headers = await authHeaders();
    const { workspaceId, cvId } = await setupWorkspace(headers);
    const res = await createRun(headers, workspaceId, cvId, "9.9.9");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: { detail: string }[] };
    expect(body.errors[0]?.detail).toContain("terraform version 9.9.9 is not available");
    // Closest names the best locally known version, whether it comes from
    // the seeded release list or a binary installed in this environment.
    const expectedClosest = closestKnownVersion("9.9.9", [
      ...(await installedBinaryVersions("terraform")),
      ...knownAvailableVersions("terraform"),
    ]);
    expect(expectedClosest).toBeDefined();
    expect(body.errors[0]?.detail).toContain(`closest known version: ${expectedClosest}`);
  });

  test("accepts a known but not-yet-installed version (worker downloads it)", async (): Promise<void> => {
    const headers = await authHeaders();
    const { workspaceId, cvId } = await setupWorkspace(headers);
    const res = await createRun(headers, workspaceId, cvId, "1.9.0");
    expect(res.status).toBe(201);
  });

  test("accepts latest (resolution needs the network)", async (): Promise<void> => {
    const headers = await authHeaders();
    const { workspaceId, cvId } = await setupWorkspace(headers);
    const res = await createRun(headers, workspaceId, cvId, "latest");
    expect(res.status).toBe(201);
  });

  test("preflights the workspace pin when the run sets no override", async (): Promise<void> => {
    const headers = await authHeaders();
    const { workspaceId, cvId } = await setupWorkspace(headers, "1.5.7");
    const res = await createRun(headers, workspaceId, cvId);
    expect(res.status).toBe(201);
  });

  test("rejects a workspace pin that names an unknown version", async (): Promise<void> => {
    const headers = await authHeaders();
    const { workspaceId, cvId } = await setupWorkspace(headers, "9.9.8");
    const res = await createRun(headers, workspaceId, cvId);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: { detail: string }[] };
    expect(body.errors[0]?.detail).toContain("terraform version 9.9.8 is not available");
  });
});
