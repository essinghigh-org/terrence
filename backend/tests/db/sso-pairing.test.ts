import { afterAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db";
import { isPostgres } from "../../src/db/driver";
import { users } from "../../src/db/schema";

const suffix = crypto.randomUUID();
const createdUserIds: string[] = [];

function userValues(id: string, identity: { provider: string | null; subject: string | null }) {
  createdUserIds.push(id);
  return {
    id,
    username: id,
    passwordHash: "unused",
    ssoProvider: identity.provider,
    ssoSubject: identity.subject,
  };
}

async function expectPairingError(operation: Promise<unknown>): Promise<void> {
  let error: unknown;
  try {
    await operation;
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  if (!isPostgres) expect((error as Error).message).toContain("sso_provider and sso_subject must be set together");
}

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, createdUserIds));
});

test("enforces all-or-nothing SSO identity pairing", async () => {
  await expectPairingError(
    db.insert(users).values(userValues(`sso-half-provider-${suffix}`, { provider: "saml", subject: null })).execute(),
  );
  await expectPairingError(
    db.insert(users).values(userValues(`sso-half-subject-${suffix}`, { provider: null, subject: "subject" })).execute(),
  );

  const localId = `sso-local-${suffix}`;
  const ssoId = `sso-valid-${suffix}`;
  await db.insert(users).values([
    userValues(localId, { provider: null, subject: null }),
    userValues(ssoId, { provider: "oidc", subject: "subject" }),
  ]);

  await expectPairingError(
    db.update(users).set({ ssoSubject: null }).where(eq(users.id, ssoId)).execute(),
  );
});
