import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens, adminSettings } from "../../src/db/schema";
import { getSettingsFresh, invalidateSettingsCache, localSignupEnabled } from "../../src/lib/settings";

describe("TFE admin provider lifecycle", () => {
  const id = `admin-provider-${crypto.randomUUID()}`;
  const token = `token-${id}`;
  const ordinaryId = `ordinary-${id}`;
  const ordinaryToken = `token-${ordinaryId}`;
  const groups = ["general", "customization", "admin-banners"];
  const saved = new Map<string, Record<string, unknown>>();
  const request = (path: string, method = "GET", body?: unknown, auth = token) =>
    app.handle(
      new Request(`http://terrence.test/api/v2/admin/${path}`, {
        method,
        headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/vnd.api+json" },
        body: body === undefined ? null : JSON.stringify(body),
      }),
    );
  const payload = (type: string, attributes: Record<string, unknown>) => ({ data: { type, attributes } });
  beforeAll(async () => {
    for (const group of groups) saved.set(group, await getSettingsFresh(group));
    await db.insert(users).values([
      { id, username: id, passwordHash: "unused", isSiteAdmin: true },
      { id: ordinaryId, username: ordinaryId, passwordHash: "unused" },
    ]);
    await db.insert(apiTokens).values([
      { id: crypto.randomUUID(), userId: id, token: createHash("sha256").update(token).digest("hex") },
      { id: crypto.randomUUID(), userId: ordinaryId, token: createHash("sha256").update(ordinaryToken).digest("hex") },
    ]);
  });
  afterAll(async () => {
    for (const [group, values] of saved)
      await db.update(adminSettings).set({ values }).where(eq(adminSettings.id, group));
    invalidateSettingsCache();
    await db.delete(apiTokens).where(eq(apiTokens.userId, id));
    await db.delete(apiTokens).where(eq(apiTokens.userId, ordinaryId));
    await db.delete(users).where(eq(users.id, id));
    await db.delete(users).where(eq(users.id, ordinaryId));
  });
  it("maps provider registration updates to real registration policy and preserves unrelated settings", async () => {
    const prior = await getSettingsFresh("general");
    const result = await request(
      "general-settings",
      "PATCH",
      payload("general-settings", { "enable-public-registration": false }),
    );
    expect(result.status).toBe(200);
    expect((await result.json()).data.attributes["enable-public-registration"]).toBe(false);
    expect(await localSignupEnabled()).toBe(false);
    expect((await getSettingsFresh("general"))["api-rate-limit"]).toBe(prior["api-rate-limit"]);
    expect(
      (await request("general-settings", "PATCH", payload("general-settings", { "enable-public-registration": "yes" })))
        .status,
    ).toBe(422);
    expect(
      (
        await request(
          "general-settings",
          "PATCH",
          payload("general-settings", { "enable-public-registration": true, "local-signup-enabled": false }),
        )
      ).status,
    ).toBe(422);
    await request("general-settings", "PATCH", payload("general-settings", { "enable-public-registration": true }));
    expect(await localSignupEnabled()).toBe(true);
  });
  it("roundtrips customization, clears values, preserves omitted settings, and reports avatar catalog", async () => {
    const attrs = {
      "support-email-address": "help@example.com",
      "support-url-address": "help.example.com",
      "internal-support-url": "https://help.example.com",
      "internal-documentation-url": "https://docs.example.com",
      "internal-tutorials-url": "https://learn.example.com",
      "login-help": "Login help",
      footer: "Footer",
      error: "Error help",
      "new-user": "Welcome",
      "avatar-sources": [{ source: "gravatar", enabled: false }],
    };
    const result = await request("customization-settings", "PATCH", payload("customization-settings", attrs));
    expect(result.status).toBe(200);
    expect((await result.json()).data.attributes).toMatchObject(attrs);
    invalidateSettingsCache();
    expect((await (await request("customization-settings")).json()).data.attributes).toMatchObject(attrs);
    const cleared = await request(
      "customization-settings",
      "PATCH",
      payload("customization-settings", { footer: "", "avatar-sources": [] }),
    );
    expect((await cleared.json()).data.attributes).toMatchObject({
      footer: "",
      "login-help": "Login help",
      "avatar-sources": [{ source: "gravatar", enabled: false }],
    });
    expect(
      (
        await request(
          "customization-settings",
          "PATCH",
          payload("customization-settings", { "avatar-sources": [{ source: "unknown", enabled: true }] }),
        )
      ).status,
    ).toBe(422);
  });
  it("creates only one banner atomically, sanitizes HTML, updates schedules, and deactivates", async () => {
    const input = payload("admin-banners", {
      title: "Maintenance",
      body: '<strong onclick="alert(1)">Hello</strong><script>alert(1)</script><a href="javascript:alert(1)">link</a>',
    });
    const results = await Promise.all([request("banners", "POST", input), request("banners", "POST", input)]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    const created = await results.find((response) => response.status === 201)!.json();
    const banner = created.data;
    expect(banner.attributes.body).toBe("<strong>Hello</strong><a>link</a>");
    expect(banner.attributes.style).toBe("info");
    expect(banner.attributes.audience).toBe("authenticated_only");
    invalidateSettingsCache();
    expect((await (await request("banners")).json()).data).toEqual([banner]);
    expect(
      (await request(`banners/${banner.id}`, "PATCH", payload("admin-banners", { timezone: "Europe/London" }))).status,
    ).toBe(422);
    const scheduled = await request(
      `banners/${banner.id}`,
      "PATCH",
      payload("admin-banners", {
        "scheduled-publish-at": "2099-01-01T10:00:00Z",
        "scheduled-expire-at": "2099-01-01T12:00:00Z",
        timezone: "Europe/London",
        style: "warning",
      }),
    );
    expect(scheduled.status).toBe(200);
    expect((await scheduled.json()).data.attributes["published-at"]).toBe("2099-01-01T10:00:00Z");
    const unscheduled = await request(
      `banners/${banner.id}`,
      "PATCH",
      payload("admin-banners", { "scheduled-publish-at": null, "scheduled-expire-at": null, timezone: null }),
    );
    expect(unscheduled.status).toBe(200);
    expect((await unscheduled.json()).data.attributes.timezone).toBeNull();
    expect((await request(`banners/${banner.id}`, "DELETE")).status).toBe(204);
    expect((await (await request("banners")).json()).data).toEqual([]);
    expect((await request(`banners/${banner.id}`, "PATCH", input)).status).toBe(404);
  });
  it("hides all admin endpoints from ordinary users, including write operations", async () => {
    for (const [path, method] of [
      ["general-settings", "GET"],
      ["general-settings", "PATCH"],
      ["customization-settings", "PATCH"],
      ["banners", "GET"],
      ["banners", "POST"],
      ["banners/unknown", "PATCH"],
      ["banners/unknown", "DELETE"],
    ]) {
      expect(
        (
          await request(
            path!,
            method!,
            method === "GET" || method === "DELETE" ? undefined : payload("admin-banners", { title: "No", body: "No" }),
            ordinaryToken,
          )
        ).status,
      ).toBe(404);
    }
  });
});
