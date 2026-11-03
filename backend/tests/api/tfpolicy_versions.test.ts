import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens, adminTfpolicyVersions } from "../../src/db/schema";

describe("Terraform policy plugin version catalog", () => {
  const suffix = crypto.randomUUID();
  const admin = `tfpolicy-admin-${suffix}`;
  const member = `tfpolicy-member-${suffix}`;
  const ids: string[] = [];
  const build = { os: "linux", arch: "amd64", url: "https://example.com/plugin.zip", sha: "a".repeat(64) };
  const request = (path = "", method = "GET", attributes?: unknown, token = admin) =>
    app.handle(
      new Request(`http://terrence.test/api/v2/admin/tfpolicy-versions${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/vnd.api+json" },
        body: attributes === undefined ? null : JSON.stringify({ data: { type: "tfpolicy-versions", attributes } }),
      }),
    );
  beforeAll(async () => {
    for (const id of [admin, member]) {
      await db.insert(users).values({ id, username: id, passwordHash: "unused", isSiteAdmin: id === admin });
      await db.insert(apiTokens).values({ id, userId: id, token: createHash("sha256").update(id).digest("hex") });
    }
  });
  afterAll(async () => {
    for (const id of ids) await db.delete(adminTfpolicyVersions).where(eq(adminTfpolicyVersions.id, id));
    for (const id of [admin, member]) await db.delete(users).where(eq(users.id, id));
  });
  it("roundtrips provider attributes, replaces builds, supports import filtering, and deletes", async () => {
    const version = `1.2.3-${suffix}`;
    const created = await request("", "POST", { version, archs: [build] });
    expect(created.status).toBe(201);
    const first = await created.json();
    const id = first.data.id as string;
    ids.push(id);
    expect(id).toMatch(/^tool-/);
    expect(first.data.type).toBe("tfpolicy-versions");
    expect(first.data.attributes).toEqual({
      version,
      archs: [build],
      official: false,
      enabled: true,
      beta: false,
      deprecated: false,
      "deprecated-reason": null,
    });
    expect((await (await request(`/${id}`)).json()).data).toEqual(first.data);
    const replacement = { ...build, arch: "arm64" };
    const updated = await request(`/${id}`, "PATCH", {
      archs: [replacement],
      deprecated: true,
      "deprecated-reason": "Superseded",
      beta: true,
      enabled: false,
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).data.attributes.archs).toEqual([replacement]);
    const retained = await request(`/${id}`, "PATCH", { enabled: true });
    expect((await retained.json()).data.attributes.archs).toEqual([replacement]);
    const undeprecated = await request(`/${id}`, "PATCH", { deprecated: false });
    expect(undeprecated.status).toBe(200);
    expect((await undeprecated.json()).data.attributes["deprecated-reason"]).toBeNull();
    const found = await (await request(`?filter[version]=${version}&page[size]=1`)).json();
    expect(found.data.map((v: { id: string }) => v.id)).toEqual([id]);
    expect((await request("", "POST", { version, archs: [build] })).status).toBe(422);
    expect((await request(`/${id}`, "DELETE")).status).toBe(204);
    expect((await request(`/${id}`)).status).toBe(404);
  });
  it("validates builds and deprecation, and protects official versions", async () => {
    const version = `2.0.0-${suffix}`;
    for (const attributes of [
      { version, archs: [] },
      { version, archs: [build], enabled: null },
      { version, archs: [build, build] },
      { version, archs: [{ ...build, sha: "invalid" }] },
      { version, archs: [{ ...build, url: "file:///etc/passwd" }] },
      { version, archs: [{ ...build, os: "windows" }] },
      { version, archs: [build], deprecated: true },
      { version, archs: [build], "deprecated-reason": "not deprecated" },
    ])
      expect((await request("", "POST", attributes)).status).toBe(422);
    const result = await request("", "POST", { version, archs: [build], official: true });
    expect(result.status).toBe(201);
    const id = (await result.json()).data.id as string;
    ids.push(id);
    expect((await request(`/${id}`, "DELETE")).status).toBe(422);
    expect((await request(`/${id}`, "PATCH", { deprecated: true })).status).toBe(422);
    expect((await request(`/${id}`)).status).toBe(200);
  });
  it("hides all operations from non-admin users", async () => {
    for (const [path, method] of [
      ["", "GET"],
      ["", "POST"],
      ["/tool-missing", "GET"],
      ["/tool-missing", "PATCH"],
      ["/tool-missing", "DELETE"],
    ]) {
      expect(
        (await request(path, method, method === "POST" || method === "PATCH" ? {} : undefined, member)).status,
      ).toBe(404);
    }
  });
});
