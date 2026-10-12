import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { organizations, workspaces, configurationVersions, runs, stateVersions } from "../../src/db/schema";
import { mintRunToken } from "../../src/lib/run-token";

for (const scenario of [
  { status: "planning", planOnly: false, speculative: false, expected: 403 },
  { status: "planned", planOnly: false, speculative: false, expected: 403 },
  { status: "applying", planOnly: true, speculative: false, expected: 403 },
  { status: "applying", planOnly: false, speculative: true, expected: 403 },
  { status: "applied", planOnly: false, speculative: false, expected: 403 },
  { status: "applying", planOnly: false, speculative: false, expected: 201 },
]) {
  test(`run state writes require an active apply: ${JSON.stringify(scenario)}`, async () => {
    const id = crypto.randomUUID();
    await db.insert(organizations).values({ id, name: id });
    await db.insert(workspaces).values({ id, orgId: id, name: id });
    await db.insert(configurationVersions).values({ id, workspaceId: id, speculative: scenario.speculative });
    await db.insert(runs).values({
      id,
      workspaceId: id,
      configurationVersionId: id,
      status: scenario.status,
      planOnly: scenario.planOnly,
      createdAt: Date.now(),
    });
    const token = await mintRunToken(id, id, id);
    const state = JSON.stringify({ version: 4, serial: 1, lineage: id, outputs: {}, resources: [] });
    const send = (suffix: string, payload: unknown) =>
      app.handle(
        new Request(`http://localhost/api/v2/workspaces/${id}/state-versions${suffix}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": suffix === "" ? "application/vnd.api+json" : "application/json",
          },
          body: typeof payload === "string" ? payload : JSON.stringify(payload),
        }),
      );
    try {
      const response = await send("", {
        data: {
          type: "state-versions",
          attributes: {
            serial: 1,
            lineage: id,
            md5: createHash("md5").update(state).digest("hex"),
            state: Buffer.from(state).toString("base64"),
          },
        },
      });
      expect(response.status).toBe(scenario.expected);
      if (scenario.expected === 403) {
        expect((await send("/upload", state)).status).toBe(403);
        expect(await db.query.stateVersions.findMany({ where: eq(stateVersions.workspaceId, id) })).toEqual([]);
      } else {
        expect(await db.query.stateVersions.findFirst({ where: eq(stateVersions.workspaceId, id) })).toBeDefined();
      }
    } finally {
      await db.delete(organizations).where(eq(organizations.id, id));
    }
  });
}
