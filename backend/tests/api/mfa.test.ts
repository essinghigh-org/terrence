import { describe, expect, test, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { ssoChallenges, users } from "../../src/db/schema";
import { generateTotpCode, generateTotpSecret, otpauthUrl, verifyTotp } from "../../src/lib/totp";

async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: { data?: { attributes?: Record<string, unknown> }; errors?: { status: string; title: string; detail?: string }[] } }> {
  const headers: Record<string, string> = {};
  if (token !== undefined && token !== "") headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/vnd.api+json";
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  let json: { data?: { attributes?: Record<string, unknown> }; errors?: { status: string; title: string; detail?: string }[] } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    // non-JSON body
  }
  return { status: res.status, json };
}

// ── TOTP unit tests ──────────────────────────────────────────────────────────
describe("totp", () => {
  test("generates a base32 secret of the expected length", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret.length).toBe(32);
  });

  test("verifyTotp accepts a freshly generated code", () => {
    const secret = generateTotpSecret();
    const code = generateTotpCode(secret);
    expect(verifyTotp(secret, code)).toBe(true);
  });

  test("verifyTotp rejects a wrong code", () => {
    const secret = generateTotpSecret();
    const code = generateTotpCode(secret);
    const wrong = code === "000000" ? "000001" : "000000";
    expect(verifyTotp(secret, wrong)).toBe(false);
  });

  test("verifyTotp accepts codes within the ±1 window", () => {
    const secret = generateTotpSecret();
    const past = generateTotpCode(secret, Date.now(), -1);
    const future = generateTotpCode(secret, Date.now(), 1);
    expect(verifyTotp(secret, past)).toBe(true);
    expect(verifyTotp(secret, future)).toBe(true);
  });

  test("verifyTotp rejects non-6-digit input", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, "12345")).toBe(false);
    expect(verifyTotp(secret, "abcdef")).toBe(false);
  });

  test("otpauthUrl has the expected shape", () => {
    const url = otpauthUrl("SECRET123", "henry@essinghigh.dev");
    expect(url.startsWith("otpauth://totp/")).toBe(true);
    expect(url).toContain("secret=SECRET123");
    expect(url).toContain("issuer=Terrence");
    expect(url).toContain("henry%40essinghigh.dev");
  });
});

// ── API contract tests (in-process app.handle) ───────────────────────────────
describe("mfa api", () => {
  let apiToken = "";
  let mfaSecret = "";
  let acceptedEnrollmentCode = "";
  const username = `mfauser_${Date.now()}`;

  beforeAll(async () => {
    const res = await api("POST", "/api/v2/users", {
      data: { type: "users", attributes: { username, password: "securepassword" } },
    });
    expect(res.status).toBe(201);

    const loginRes = await api("POST", "/api/v2/users/login", {
      data: { attributes: { username, password: "securepassword" } },
    });
    expect(loginRes.status).toBe(200);
    apiToken = (loginRes.json.data?.attributes?.["token"] as string) ?? "";
    expect(apiToken).not.toBe("");
  });

  test("GET /account/mfa returns disabled by default", async () => {
    const res = await api("GET", "/api/v2/account/mfa", undefined, apiToken);
    expect(res.status).toBe(200);
    expect(res.json.data?.attributes?.["enabled"]).toBe(false);
  });

  test("POST /account/mfa/enroll requires the current password", async () => {
    const res = await api("POST", "/api/v2/account/mfa/enroll", undefined, apiToken);
    expect(res.status).toBe(422);
  });

  test("POST /account/mfa/enroll returns a secret and otpauth URL", async () => {
    const res = await api(
      "POST",
      "/api/v2/account/mfa/enroll",
      { data: { attributes: { "current-password": "securepassword" } } },
      apiToken,
    );
    expect(res.status).toBe(200);
    const attrs = res.json.data?.attributes ?? {};
    mfaSecret = attrs["secret"] as string;
    expect(mfaSecret).toMatch(/^[A-Z2-7]+$/);
    expect(attrs["otpauth-url"]).toContain("otpauth://totp/");
  });

  test("verifyTotp works against the enrolled secret", () => {
    expect(mfaSecret).not.toBe("");
    const code = generateTotpCode(mfaSecret);
    expect(verifyTotp(mfaSecret, code)).toBe(true);
  });

  test("POST /account/mfa/verify enables MFA with a valid code", async () => {
    const code = generateTotpCode(mfaSecret, Date.now() - 30_000);
    acceptedEnrollmentCode = code;
    const res = await api("POST", "/api/v2/account/mfa/verify", { data: { attributes: { code } } }, apiToken);
    expect(res.status).toBe(200);
    expect(res.json.data?.attributes?.["enabled"]).toBe(true);
  });

  test("POST /account/mfa/verify rejects reuse of an accepted TOTP code", async () => {
    const res = await api("POST", "/api/v2/account/mfa/verify", { data: { attributes: { code: acceptedEnrollmentCode } } }, apiToken);
    expect(res.status).toBe(401);
  });

  test("POST /account/mfa/verify rejects an invalid code", async () => {
    const res = await api("POST", "/api/v2/account/mfa/verify", { data: { attributes: { code: "000000" } } }, apiToken);
    expect(res.status).toBe(401);
  });

  test("login returns mfa-required + challenge token once MFA is enabled", async () => {
    const res = await api("POST", "/api/v2/users/login", {
      data: { attributes: { username, password: "securepassword" } },
    });
    expect(res.status).toBe(200);
    const attrs = res.json.data?.attributes ?? {};
    expect(attrs["mfa-required"]).toBe(true);
    const challengeToken = attrs["mfa-challenge-token"] as string;
    expect(challengeToken).toMatch(/^mfa-/);
    expect(attrs["token"]).toBeUndefined();
  });

  test("stores MFA login challenges in the shared durable challenge table", async () => {
    const res = await api("POST", "/api/v2/users/login", {
      data: { attributes: { username, password: "securepassword" } },
    });
    const challengeToken = res.json.data?.attributes?.["mfa-challenge-token"] as string;
    expect(challengeToken).toMatch(/^mfa-/);
    const row = await db.query.ssoChallenges.findFirst({ where: eq(ssoChallenges.id, challengeToken) });
    const account = await db.query.users.findFirst({ where: eq(users.username, username) });
    expect(row?.kind).toBe("mfa-login");
    expect(account).toBeDefined();
    expect(row?.payload["userId"]).toBe(account?.id);
  });

  test("POST /users/login/mfa completes login with a valid code", async () => {
    const challengeRes = await api("POST", "/api/v2/users/login", {
      data: { attributes: { username, password: "securepassword" } },
    });
    const challengeToken = challengeRes.json.data?.attributes?.["mfa-challenge-token"] as string;
    expect(challengeToken).toBeDefined();

    const code = generateTotpCode(mfaSecret);
    const res = await api("POST", "/api/v2/users/login/mfa", {
      data: { attributes: { "challenge-token": challengeToken, code } },
    });
    expect(res.status).toBe(200);
    expect((res.json.data?.attributes?.["token"] as string) ?? "").not.toBe("");
  });

  test("POST /users/login/mfa rejects a bad code", async () => {
    const challengeRes = await api("POST", "/api/v2/users/login", {
      data: { attributes: { username, password: "securepassword" } },
    });
    const challengeToken = challengeRes.json.data?.attributes?.["mfa-challenge-token"] as string;
    const res = await api("POST", "/api/v2/users/login/mfa", {
      data: { attributes: { "challenge-token": challengeToken, code: "000000" } },
    });
    expect(res.status).toBe(401);
  });

  test("DELETE /account/mfa requires the current password", async () => {
    const code = generateTotpCode(mfaSecret);
    const res = await api("DELETE", "/api/v2/account/mfa", { data: { attributes: { code } } }, apiToken);
    expect(res.status).toBe(422);
  });

  test("DELETE /account/mfa disables with a valid code", async () => {
    const code = generateTotpCode(mfaSecret, Date.now() + 30_000);
    const res = await api(
      "DELETE",
      "/api/v2/account/mfa",
      { data: { attributes: { code, "current-password": "securepassword" } } },
      apiToken,
    );
    expect(res.status).toBe(200);
    expect(res.json.data?.attributes?.["enabled"]).toBe(false);
  });

  test("login returns a token again after MFA is disabled", async () => {
    const res = await api("POST", "/api/v2/users/login", {
      data: { attributes: { username, password: "securepassword" } },
    });
    expect(res.status).toBe(200);
    const attrs = res.json.data?.attributes ?? {};
    expect(attrs["mfa-required"]).toBeUndefined();
    expect((attrs["token"] as string) ?? "").not.toBe("");
  });
});
