import * as bcrypt from "bcryptjs";
import { count, eq } from "drizzle-orm";
import { db } from "../db";
import { organizationMemberships, organizations, samlSettings, users } from "../db/schema";
import { auditLog } from "./utils";

export async function bootstrapInitialAdmin(): Promise<"created" | "disabled" | "skipped"> {
  const password = process.env.ADMIN_PASSWORD;
  if (password === undefined || password === "") return "disabled";
  delete process.env.ADMIN_PASSWORD;

  const userCount = (await db.select({ value: count() }).from(users))[0]?.value ?? 0;
  if (userCount > 0) return "skipped";
  if (password.length < 10) {
    throw new Error("ADMIN_PASSWORD must be at least 10 characters");
  }

  const username = (process.env.ADMIN_USERNAME ?? "admin").trim();
  if (username === "") throw new Error("ADMIN_USERNAME cannot be empty");
  const configuredEmail = process.env.ADMIN_EMAIL?.trim();
  const email = configuredEmail === undefined || configuredEmail === "" ? null : configuredEmail;
  const organizationName = (process.env.ADMIN_ORGANIZATION ?? "default").trim();
  if (organizationName === "") throw new Error("ADMIN_ORGANIZATION cannot be empty");
  const id = `user-${crypto.randomUUID()}`;
  const organizationId = `org-${crypto.randomUUID()}`;
  const passwordHash = await bcrypt.hash(password, 10);

  const created = await db.transaction(async (tx: unknown): Promise<{ created: boolean; organizationCreated: boolean }> => {
    const t = tx as typeof db;
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
