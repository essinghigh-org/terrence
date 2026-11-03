import { createHash, X509Certificate } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { adminSettings, apiTokens, samlSettings, users } from "../../src/db/schema";
import { SAML_CERTIFICATES_KEY, trustedSamlCertificates } from "../../src/lib/saml-certificates";
import { IDP_CERT, IDP_OLD_CERT } from "./saml_helpers";

describe("SAML IdP certificate provider API", () => {
  const id = `usr-cert-${crypto.randomUUID()}`;
  const token = `cert-token-${crypto.randomUUID()}`;
  const path = "/api/v2/admin/saml-settings/idp-certificates";
  const request = (method: string, endpoint = path, attrs?: Record<string, unknown>, authenticated = true) =>
    app.handle(
      new Request(`http://terrence.test${endpoint}`, {
        method,
        headers: {
          ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/vnd.api+json",
        },
        body: attrs
          ? JSON.stringify({
              data: {
                type: endpoint === path.replace("/idp-certificates", "") ? "saml-settings" : "saml-idp-certificates",
                attributes: attrs,
              },
            })
          : null,
      }),
    );
  beforeAll(async () => {
    await db.insert(users).values({ id, username: id, passwordHash: "unused", isSiteAdmin: true });
    await db
      .insert(apiTokens)
      .values({ id: `api-${id}`, userId: id, token: createHash("sha256").update(token).digest("hex") });
  });
  afterAll(async () => {
    await db.delete(adminSettings).where(eq(adminSettings.id, SAML_CERTIFICATES_KEY));
    await db.delete(samlSettings).where(eq(samlSettings.id, "saml"));
    await db.delete(apiTokens).where(eq(apiTokens.userId, id));
    await db.delete(users).where(eq(users.id, id));
  });
  test("CRUD, both data-source reads, ordering, X.509 metadata, and enable/delete guards", async () => {
    expect((await request("GET", path, undefined, false)).status).not.toBe(200);
    expect((await request("GET")).status).toBe(200);
    expect((await request("POST", path, { "display-name": "bad", cert: "garbage" })).status).toBe(422);
    const created = await request("POST", path, { "display-name": "first", cert: IDP_CERT });
    expect(created.status).toBe(201);
    const a = (await created.json()).data;
    expect(a.id).toMatch(/^idpc-/);
    expect(a.attributes).toMatchObject({
      "cert-role": "managed",
      fingerprint: new X509Certificate(IDP_CERT).fingerprint256,
      cert: IDP_CERT,
    });
    expect(Number.isNaN(Date.parse(a.attributes["expires-at"]))).toBeFalse();
    expect((await (await request("GET", `${path}/${a.id}`)).json()).data).toEqual(a);
    expect((await request("POST", path, { "display-name": "duplicate", cert: IDP_CERT })).status).toBe(422);
    const b = (await (await request("POST", path, { "display-name": "second", cert: IDP_OLD_CERT })).json()).data;
    expect((await request("PATCH", `${path}/${a.id}`, { cert: IDP_OLD_CERT })).status).toBe(422);
    const updated = await request("PATCH", `${path}/${a.id}`, { "display-name": "renamed", cert: IDP_CERT });
    expect(updated.status).toBe(200);
    expect((await updated.json()).data.attributes.fingerprint).toBe(new X509Certificate(IDP_CERT).fingerprint256);
    const list = (await (await request("GET")).json()).data;
    expect(list.map((item: { id: string }) => item.id)).toEqual([b.id, a.id]);
    expect(
      (
        await request("PATCH", path.replace("/idp-certificates", ""), {
          enabled: true,
          "sso-endpoint-url": "https://idp.example.test/sso",
        })
      ).status,
    ).toBe(200);
    const settings = (await db.query.samlSettings.findFirst({ where: eq(samlSettings.id, "saml") }))!;
    expect(await trustedSamlCertificates(settings)).toEqual([IDP_OLD_CERT, IDP_CERT]);
    expect((await request("DELETE", `${path}/${b.id}`)).status).toBe(204);
    expect((await request("DELETE", `${path}/${a.id}`)).status).toBe(422);
    expect((await request("PATCH", path.replace("/idp-certificates", ""), { enabled: false })).status).toBe(200);
    expect((await request("DELETE", `${path}/${a.id}`)).status).toBe(204);
    expect((await request("GET", `${path}/${a.id}`)).status).toBe(404);
    expect((await request("PATCH", path.replace("/idp-certificates", ""), { enabled: true })).status).toBe(422);
  });
  test("legacy certificates can be imported, renamed and deleted, but not replaced through the new API", async () => {
    const settingsPath = path.replace("/idp-certificates", "");
    expect((await request("PATCH", settingsPath, { "idp-cert": IDP_CERT })).status).toBe(200);
    const a = (await (await request("GET")).json()).data[0];
    expect(a.attributes["cert-role"]).toBe("legacy_primary");
    expect((await request("PATCH", `${path}/${a.id}`, { "display-name": "imported" })).status).toBe(200);
    expect((await request("PATCH", `${path}/${a.id}`, { cert: IDP_OLD_CERT })).status).toBe(422);
    expect((await request("PATCH", settingsPath, { "idp-cert": IDP_OLD_CERT })).status).toBe(200);
    const items = (await (await request("GET")).json()).data;
    expect(items.map((item: { attributes: Record<string, unknown> }) => item.attributes["cert-role"])).toEqual([
      "legacy_primary",
      "legacy_old",
    ]);
    expect(items[1].id).toBe(a.id);
    expect(items[1].attributes["display-name"]).toBe("imported");
    expect((await request("DELETE", `${path}/${a.id}`)).status).toBe(204);
    expect((await (await request("GET")).json()).data).toHaveLength(1);
    // A legacy old certificate can be the final trust anchor after the
    // primary was removed through the new resource API.
    expect((await request("PATCH", settingsPath, { "idp-cert": IDP_CERT })).status).toBe(200);
    const rotated = (await (await request("GET")).json()).data;
    expect((await request("DELETE", `${path}/${rotated[0].id}`)).status).toBe(204);
    expect((await request("PATCH", settingsPath, { enabled: true })).status).toBe(200);
    expect((await request("DELETE", `${path}/${rotated[1].id}`)).status).toBe(422);
    expect((await request("POST", `${settingsPath}/actions/revoke-old-certificate`)).status).toBe(422);
    expect((await request("PATCH", settingsPath, { enabled: false })).status).toBe(200);
  });
});
