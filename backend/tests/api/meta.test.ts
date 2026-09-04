import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, users } from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";

type SandboxMeta = {
  data?: {
    id?: string;
    type?: string;
    attributes?: {
      "run-sandbox"?: {
        enabled: boolean;
        available: boolean;
        abi: number;
        reason: string | null;
        docs: string;
      };
    };
  };
};

const userId = `meta-test-user-${crypto.randomUUID()}`;
const token = `meta-test-token-${crypto.randomUUID()}`;
const tokenId = `meta-test-token-row-${crypto.randomUUID()}`;

beforeAll(async () => {
  await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
  await db.insert(apiTokens).values({ id: tokenId, token: hashAuthenticationToken(token), userId });
});

afterAll(async () => {
  await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
  await db.delete(users).where(eq(users.id, userId));
});

test("GET /api/v2/meta reports the run sandbox status for an authenticated caller", async () => {
  const response = await app.handle(new Request("http://localhost/api/v2/meta", {
    headers: { Authorization: `Bearer ${token}` },
  }));
  expect(response.status).toBe(200);
  const payload = (await response.json()) as SandboxMeta;
  expect(payload.data?.id).toBe("meta");
  expect(payload.data?.type).toBe("meta");
  const sandbox = payload.data?.attributes?.["run-sandbox"];
  expect(sandbox).toBeDefined();
  expect(typeof sandbox?.enabled).toBe("boolean");
  expect(typeof sandbox?.available).toBe("boolean");
  expect(typeof sandbox?.abi).toBe("number");
  expect(typeof sandbox?.docs).toBe("string");
});

test("GET /api/v2/capabilities returns a typed JSON:API resource", async () => {
  const response = await app.handle(new Request("http://localhost/api/v2/capabilities", {
    headers: { Authorization: `Bearer ${token}` },
  }));
  expect(response.status).toBe(200);
  const payload = await response.json() as {
    data?: {
      id?: string;
      type?: string;
      attributes?: Record<string, unknown>;
    };
  };
  expect(payload.data?.id).toBe("capabilities");
  expect(payload.data?.type).toBe("capabilities");
  expect(payload.data?.attributes?.["rate-limits"]).toBeTypeOf("object");
});
