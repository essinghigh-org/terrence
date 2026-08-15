import { count, eq } from "drizzle-orm";
import { db } from "../db";
import { organizationMemberships, organizations, samlSettings, users } from "../db/schema";
import { auditLog } from "./utils";
import { checkPasswordPolicy, loadPasswordPolicy } from "./password-policy";
import { lockFirstUserElection } from "../db/first-user";

export async function bootstrapInitialAdmin(): Promise<"created" | "disabled" | "skipped"> {
  const password = process.env.ADMIN_PASSWORD;
  if (password === undefined || password === "") return "disabled";
  delete process.env.ADMIN_PASSWORD;

  const userCount = (await db.select({ value: count() }).from(users))[0]?.value ?? 0;
  if (userCount > 0) return "skipped";
  const bootstrapUsername = (process.env.ADMIN_USERNAME ?? "admin").trim();
  const policy = checkPasswordPolicy(loadPasswordPolicy(), password, bootstrapUsername);
  if (!policy.ok) {
    // Preserve the long-standing exact message for the common minimum-length
    // case so existing deployments/tests keyed on it keep working; include the
    // full breakdown for any stricter or combined failures.
    const isOnlyLength = policy.errors.length === 1 && policy.errors[0]?.startsWith("Password must be at least ");
    const message = isOnlyLength
      ? `ADMIN_PASSWORD ${policy.errors[0]?.replace(/^Password /, "").toLowerCase()}` : `ADMIN_PASSWORD is invalid: ${policy.errors.join(" ")}`;
    throw new Error(message);
  }

  const username = bootstrapUsername;
  if (username === "") throw new Error("ADMIN_USERNAME cannot be empty");
  const configuredEmail = process.env.ADMIN_EMAIL?.trim();
  const email = configuredEmail === undefined || configuredEmail === "" ? null : configuredEmail;
  const organizationName = (process.env.ADMIN_ORGANIZATION ?? "default").trim();
  if (organizationName === "") throw new Error("ADMIN_ORGANIZATION cannot be empty");
  const id = `user-${crypto.randomUUID()}`;
  const organizationId = `org-${crypto.randomUUID()}`;
  const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });

  const created = await db.transaction(async (tx: unknown): Promise<{ created: boolean; organizationCreated: boolean }> => {
    const t = tx as typeof db;
    // Serialize the first-user election across concurrent processes (PG
    // advisory lock; no-op on SQLite): see db/first-user.ts.
    await lockFirstUserElection(t);
    const currentCount = (await t.select({ value: count() }).from(users))[0]?.value ?? 0;
    if (currentCount > 0) return { created: false, organizationCreated: false };
    await t.insert(users).values({
      id,
      username,
      email,
      passwordHash,
      isSiteAdmin: true,
      mustChangePassword: true,
    });
    const existingOrganization = await t.query.organizations.findFirst({
      where: eq(organizations.name, organizationName),
    });
    const targetOrganizationId = existingOrganization?.id ?? organizationId;
    if (existingOrganization === undefined) {
      const saml = await t.query.samlSettings.findFirst({ where: eq(samlSettings.id, "saml") });
      await t.insert(organizations).values({
        id: targetOrganizationId,
        name: organizationName,
        samlEnabled: saml?.enabled ?? false,
      });
    }
    await t.insert(organizationMemberships).values({
      id: `oum-${crypto.randomUUID()}`,
      userId: id,
      orgId: targetOrganizationId,
      role: "owner",
    });
    return { created: true, organizationCreated: existingOrganization === undefined };
  });
  if (!created.created) return "skipped";

  await auditLog("create", "users", id, id, null, { username, source: "ADMIN_PASSWORD" });
  if (created.organizationCreated) {
    await auditLog("create", "organizations", organizationId, id, organizationId, {
      name: organizationName,
      source: "ADMIN_PASSWORD",
    });
  }
  return "created";
}
