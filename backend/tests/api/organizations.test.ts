import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { organizations } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("the reference format API v2 - Organizations", () => {
  let userToken: string;
  const username = `org_owner_${Date.now()}`;
  const orgName = `my_homelab_${Date.now()}`;

  beforeAll(async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { type: "users", attributes: { username, password: "securepassword" } },
        }),
      })
    );
    expect(res.status).toBe(201);

    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username, password: "securepassword" } },
        }),
      })
    );
    userToken = (await loginRes.json()).data.attributes.token;
  });

  it("should create an organization", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v2/organizations", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: { type: "organizations", attributes: { name: orgName, email: "admin@homelab.local" } }
        })
      })
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.data.attributes.name).toBe(orgName);

    const orgInDb = await db.query.organizations.findFirst({
      where: eq(organizations.name, orgName)
    });
    expect(orgInDb).toBeDefined();
  });

  it("keeps legacy reserved-name organizations editable", async () => {
    await db.update(organizations).set({ name: "docs" }).where(eq(organizations.name, orgName));
    try {
      const res = await app.handle(new Request("http://localhost/api/v2/organizations/docs", {
        method: "PATCH",
        headers: { "Content-Type": "application/vnd.api+json", Authorization: `Bearer ${userToken}` },
        body: JSON.stringify({ data: { attributes: { name: "docs", email: "updated@example.com" } } }),
      }));
      expect(res.status).toBe(200);
      expect((await res.json()).data.attributes.email).toBe("updated@example.com");
    } finally {
      await db.update(organizations).set({ name: orgName }).where(eq(organizations.name, "docs"));
    }
  });

  it("rejects reserved and path-unsafe organization names on create and rename", async () => {
    const invalidNames = ["account", "ADMIN", "docs", "DOCS", "nested/name", "contains space", "contains.dot"];
    for (const name of invalidNames) {
      const res = await app.handle(
        new Request("http://localhost/api/v2/organizations", {
          method: "POST",
          headers: {
            "Content-Type": "application/vnd.api+json",
            "Authorization": `Bearer ${userToken}`
          },
          body: JSON.stringify({
            data: { type: "organizations", attributes: { name } }
          })
        })
      );
      expect(res.status).toBe(422);
    }

    for (const name of invalidNames) {
      const res = await app.handle(
        new Request(`http://localhost/api/v2/organizations/${orgName}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/vnd.api+json",
            "Authorization": `Bearer ${userToken}`
          },
          body: JSON.stringify({
            data: { type: "organizations", attributes: { name } }
          })
        })
      );
      expect(res.status).toBe(422);
    }

    const unchanged = await db.query.organizations.findFirst({
      where: eq(organizations.name, orgName),
    });
    expect(unchanged).toBeDefined();
  });

  it("should get an organization by name", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${userToken}`
        }
      })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data.attributes.name).toBe(orgName);
  });

  it("should list organizations", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v2/organizations", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${userToken}`
        }
      })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.data)).toBe(true);
    expect(data.data.some((o: any) => o.attributes?.name === orgName)).toBe(true);
  });
});
