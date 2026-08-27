import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizationMemberships, organizations, user2FA, users } from "../../src/db/schema";
import { isEncryptedSecret } from "../../src/lib/secrets";

// TOTP seed encryption at rest (todo 110-112): enrollment stores the seed
// ONLY in encrypted form; a legacy plaintext seed migrates transparently on
// first successful verify; the enc:v1 prefix check prevents double-encrypt.
describe("TOTP seed encryption at rest", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `mfaenc-org-${suffix}`;
  const auth = `user-token-${suffix}`;
  // TOTP secrets are base32 (RFC 4648); derive a deterministic test secret.
  const base32 = (input: string): string => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let out = "";
    for (let i = 0; i < 6; i += 1) {
      const digest = createHmac("sha256", `${input}:${i}`).update(input).digest("hex");
      for (const nibble of digest) out += alphabet[parseInt(nibble, 16) % 32];
    }
    return out.slice(0, 32);
  };

  const api = (method: string, path: string, body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({ id: crypto.randomUUID(), userId, orgId, role: "owner" });
    await db.insert(apiTokens).values({ id: crypto.randomUUID(), token: hashAuthenticationToken(auth), userId });
  });

  afterAll(async () => {
    await db.delete(user2FA).where(eq(user2FA.userId, userId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
  });

  it("enroll stores the seed only encrypted; verify migrates legacy plaintext", async () => {
    const enroll = await api("POST", "/api/v2/account/mfa/enroll");
    expect(enroll.status).toBe(200);
    const row = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, userId) });
    expect(row).toBeDefined();
    expect(row!.secretEncrypted).not.toBeNull();
    expect(isEncryptedSecret(row!.secretEncrypted!)).toBe(true);
    // The plaintext column must NOT hold the seed anymore.
    expect(row!.secret).toBe("");

    // A valid code flips enrollment on (seed resolves from the encrypted col).
    const enrollBody = (await enroll.json()) as { data: { attributes: { secret: string } } };
    const { generateTotpCode } = (await import("../../src/lib/totp")) as unknown as { generateTotpCode: (s: string) => string };
    const code = generateTotpCode(enrollBody.data.attributes.secret);
    const verify = await api("POST", "/api/v2/account/mfa/verify", { data: { attributes: { code } } });
    expect(verify.status).toBe(200);

    // Still encrypted after verification.
    const after = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, userId) });
    expect(isEncryptedSecret(after!.secretEncrypted!)).toBe(true);
    expect(after!.secret).toBe("");
  });

  it("legacy plaintext seed migrates on first successful verify without double-encrypting", async () => {
    const userId2 = `user-legacy-${suffix}`;
    await db.insert(users).values({ id: userId2, username: userId2, passwordHash: "unused" });
    await db.insert(apiTokens).values({ id: crypto.randomUUID(), token: hashAuthenticationToken(`legacy-token-${suffix}`), userId: userId2 });
    const legacySecret = base32(`legacy-${suffix}`);
    await db.insert(user2FA).values({ userId: userId2, secret: legacySecret, enabled: false });

    const { verifyTotp } = await import("../../src/lib/totp");
    const { generateTotpCode } = (await import("../../src/lib/totp")) as unknown as { generateTotpCode: (s: string) => string };
    const code = generateTotpCode(legacySecret);
    expect(verifyTotp(legacySecret, code)).toBe(true);

    const legacyAuth = `legacy-token-${suffix}`;
    const verify = await app.handle(new Request("http://terrence.test/api/v2/account/mfa/verify", {
      method: "POST",
      headers: { Authorization: `Bearer ${legacyAuth}`, "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({ data: { attributes: { code } } }),
    }));
    expect(verify.status).toBe(200);

    const row = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, userId2) });
    expect(row).toBeDefined();
    // Migrated: plaintext column cleared, encrypted column populated ONCE
    // (single enc:v1 payload, not a nested/double-encrypted value).
    expect(row!.secret).toBe("");
    expect(row!.secretEncrypted).not.toBeNull();
    expect(isEncryptedSecret(row!.secretEncrypted!)).toBe(true);
    expect((row!.secretEncrypted!.match(/enc:v1/g) ?? []).length).toBe(1);

    await db.delete(apiTokens).where(eq(apiTokens.userId, userId2));
    await db.delete(user2FA).where(eq(user2FA.userId, userId2));
    await db.delete(users).where(eq(users.username, userId2));
  });
});