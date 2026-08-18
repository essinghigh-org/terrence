import { describe, expect, test, beforeAll } from "bun:test";
import { app } from "../../src/app";

async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: { data?: Record<string, unknown>; errors?: { status: string; title: string; detail?: string }[] } }> {
  const headers: Record<string, string> = {};
  if (token !== undefined && token !== "") headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/vnd.api+json";
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  let json: { data?: Record<string, unknown>; errors?: { status: string; title: string; detail?: string }[] } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    // non-JSON
  }
  return { status: res.status, json };
}

describe("project-owned variable sets", () => {
  let token = "";
  let orgName = "";
  let projectId = "";
  const username = `vsuser_${Date.now()}`;
  const password = "securepassword";

  beforeAll(async () => {
    const res = await api("POST", "/api/v2/users", {
      data: { type: "users", attributes: { username, password } },
    });
    expect(res.status).toBe(201);

    const login = await api("POST", "/api/v2/users/login", {
      data: { attributes: { username, password } },
    });
    expect(login.status).toBe(200);
    const loginData = login.json.data as { attributes?: { token?: string } } | undefined;
    token = loginData?.attributes?.token ?? "";
    expect(token).not.toBe("");

    orgName = `vsorg_${Date.now()}`;
    const org = await api("POST", "/api/v2/organizations", {
      data: { type: "organizations", attributes: { name: orgName } },
    }, token);
    expect(org.status).toBe(201);

    const project = await api("POST", `/api/v2/organizations/${encodeURIComponent(orgName)}/projects`, {
      data: { type: "projects", attributes: { name: "project-owned-test" } },
    }, token);
    expect(project.status).toBe(201);
    projectId = (project.json.data?.id as string) ?? "";
    expect(projectId).not.toBe("");
  });

  test("creates an org-owned variable set (no parent)", async () => {
    const res = await api("POST", `/api/v2/organizations/${encodeURIComponent(orgName)}/varsets`, {
      data: {
        type: "varsets",
        attributes: { name: "Org-wide vars", global: true },
      },
    }, token);
    expect(res.status).toBe(201);
    const attrs = res.json.data?.attributes as Record<string, unknown> | undefined;
    expect(attrs?.["parent-project-id"]).toBeNull();
    expect(attrs?.global).toBe(true);
  });

  test("creates a project-owned variable set via parent-project-id", async () => {
    const res = await api("POST", `/api/v2/organizations/${encodeURIComponent(orgName)}/varsets`, {
      data: {
        type: "varsets",
        attributes: { name: "Project vars", "parent-project-id": projectId },
      },
    }, token);
    expect(res.status).toBe(201);
    const attrs = res.json.data?.attributes as Record<string, unknown> | undefined;
    expect(attrs?.["parent-project-id"]).toBe(projectId);
    // Project-owned sets can never be global (the reference format contract)
    expect(attrs?.global).toBe(false);
  });

  test("rejects global=true with parent-project-id (the reference format: mutually exclusive)", async () => {
    const res = await api("POST", `/api/v2/organizations/${encodeURIComponent(orgName)}/varsets`, {
      data: {
        type: "varsets",
        attributes: { name: "Bad", global: true, "parent-project-id": projectId },
      },
    }, token);
    expect(res.status).toBe(422);
  });

  test("rejects a parent project from another org", async () => {
    const otherOrgName = `vsorg2_${Date.now()}`;
    await api("POST", "/api/v2/organizations", {
      data: { type: "organizations", attributes: { name: otherOrgName } },
    }, token);
    const otherProject = await api("POST", `/api/v2/organizations/${encodeURIComponent(otherOrgName)}/projects`, {
      data: { type: "projects", attributes: { name: "other" } },
    }, token);
    expect(otherProject.status).toBe(201);
    const res = await api("POST", `/api/v2/organizations/${encodeURIComponent(orgName)}/varsets`, {
      data: {
        type: "varsets",
        attributes: { name: "Cross-org", "parent-project-id": otherProject.json.data?.id as string },
      },
    }, token);
    expect(res.status).toBe(422);
  });

  test("filter[project][id] returns owned variable sets", async () => {
    const res = await api("GET", `/api/v2/organizations/${encodeURIComponent(orgName)}/varsets?filter%5Bproject%5D%5Bid%5D=${encodeURIComponent(projectId)}`, undefined, token);
    expect(res.status).toBe(200);
    const data = res.json.data as { id?: string }[] | undefined;
    const items = Array.isArray(data) ? data : [];
    expect(items.some((item): boolean => (item.id ?? "").startsWith("varset-"))).toBe(true);
  });

  test("PATCH cannot change the owning project", async () => {
    const created = await api("POST", `/api/v2/organizations/${encodeURIComponent(orgName)}/varsets`, {
      data: {
        type: "varsets",
        attributes: { name: "Immutable parent", "parent-project-id": projectId },
      },
    }, token);
    const varsetId = created.json.data?.id as string;
    const res = await api("PATCH", `/api/v2/varsets/${varsetId}`, {
      data: { type: "varsets", attributes: { "parent-project-id": null } },
    }, token);
    expect(res.status).toBe(422);
  });

  test("PATCH cannot make a project-owned set global", async () => {
    const created = await api("POST", `/api/v2/organizations/${encodeURIComponent(orgName)}/varsets`, {
      data: {
        type: "varsets",
        attributes: { name: "Project no-global", "parent-project-id": projectId },
      },
    }, token);
    const varsetId = created.json.data?.id as string;
    const res = await api("PATCH", `/api/v2/varsets/${varsetId}`, {
      data: { type: "varsets", attributes: { global: true } },
    }, token);
    expect(res.status).toBe(422);
  });

  test("list includes project-owned sets with scope visible", async () => {
    const res = await api("GET", `/api/v2/organizations/${encodeURIComponent(orgName)}/varsets`, undefined, token);
    expect(res.status).toBe(200);
    const data = res.json.data as { attributes?: Record<string, unknown> }[] | undefined;
    const items = Array.isArray(data) ? data : [];
    expect(items.some((item): boolean => item.attributes?.["parent-project-id"] === projectId)).toBe(true);
  });
});
