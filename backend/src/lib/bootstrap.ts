import { count, eq } from "drizzle-orm";
import { accessSync, constants as fsConstants, mkdirSync } from "node:fs";
import { db } from "../db";
import { storageDir } from "../db/driver";
import { organizationMemberships, organizations, samlSettings, users } from "../db/schema";
import { auditLog } from "./utils";
import { envEnabled } from "./env";
import { checkPasswordPolicy, loadPasswordPolicy } from "./password-policy";
import { lockFirstUserElection } from "../db/first-user";
import { hashPassword } from "./password-hashing";

function consumeAdminPassword(): string | null {
  const password = process.env["ADMIN_PASSWORD"];
  if (password === undefined || password === "") return null;
  delete process.env["ADMIN_PASSWORD"];
  return password;
}

function validateBootstrapPassword(password: string, username: string): void {
  const policy = checkPasswordPolicy(loadPasswordPolicy(), password, username);
  if (policy.ok) return;
  const isOnlyLength = policy.errors.length === 1 && policy.errors[0]?.startsWith("Password must be at least ");
  const message = isOnlyLength ? `ADMIN_PASSWORD ${policy.errors[0]?.replace(/^Password /, "").toLowerCase()}` : `ADMIN_PASSWORD is invalid: ${policy.errors.join(" ")}`;
  throw new Error(message);
}

function resolveBootstrapIdentity(username: string): { username: string; email: string | null; organizationName: string } {
  if (username === "") throw new Error("ADMIN_USERNAME cannot be empty");
  const configuredEmail = process.env["ADMIN_EMAIL"]?.trim();
  const email = configuredEmail === undefined || configuredEmail === "" ? null : configuredEmail;
  const organizationName = (process.env["ADMIN_ORGANIZATION"] ?? "default").trim();
  if (organizationName === "") throw new Error("ADMIN_ORGANIZATION cannot be empty");
  return { username, email, organizationName };
}

export async function bootstrapInitialAdmin(): Promise<"created" | "disabled" | "skipped"> {
  const password = consumeAdminPassword();
  if (password === null) return "disabled";

  const userCount = (await db.select({ value: count() }).from(users))[0]?.value ?? 0;
  if (userCount > 0) return "skipped";
  const bootstrapUsername = (process.env["ADMIN_USERNAME"] ?? "admin").trim();
  validateBootstrapPassword(password, bootstrapUsername);

  const { username, email, organizationName } = resolveBootstrapIdentity(bootstrapUsername);
  const id = `user-${crypto.randomUUID()}`;
  const organizationId = `org-${crypto.randomUUID()}`;
  const passwordHash = await hashPassword(password);

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

/**
 * One-shot solo-admin password recovery (issue #631). The bootstrap and the
 * account endpoints both refuse password changes without the current
 * password, which leaves a solo admin who lost theirs with no supported
 * path short of database surgery. With TERRENCE_ADMIN_PASSWORD_RESET=1 and
 * ADMIN_PASSWORD set, this resets the named site-admin account
 * (ADMIN_USERNAME, default admin) to the new password and forces a change
 * at next login. Anything else (flag unset, missing password, unknown or
 * non-admin user) leaves the instance untouched. Runs before
 * bootstrapInitialAdmin: the bootstrap consumes ADMIN_PASSWORD on fresh
 * installs, so ordering keeps both paths intact.
 */
export async function resetAdminPassword(): Promise<"reset" | "disabled"> {
  if (!envEnabled(process.env["TERRENCE_ADMIN_PASSWORD_RESET"])) return "disabled";
  const password = process.env["ADMIN_PASSWORD"];
  if (password === undefined || password === "") return "disabled";
  const username = (process.env["ADMIN_USERNAME"] ?? "admin").trim();
  if (username === "") return "disabled";
  validateBootstrapPassword(password, username);
  const target = await db.query.users.findFirst({ where: eq(users.username, username) });
  if (target === undefined || target.isSiteAdmin !== true) return "disabled";
  await db.update(users)
    .set({ passwordHash: await hashPassword(password), mustChangePassword: true })
    .where(eq(users.id, target.id));
  delete process.env["ADMIN_PASSWORD"];
  await auditLog("update", "users", target.id, target.id, null, { username, source: "ADMIN_PASSWORD_RESET" });
  return "reset";
}

/**
 * Fail fast when the storage directory is not writable (issue #631).
 * Without this, a skipped volume-ownership step surfaces later as cryptic
 * permission errors on the first Docker run. The message names the path,
 * the process identity, and the exact host command that fixes it.
 */
export function assertStorageWritable(dir: string = storageDir): void {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, fsConstants.W_OK);
  } catch {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const gid = typeof process.getgid === "function" ? process.getgid() : null;
    const owner = uid !== null && gid !== null ? `${uid}:${gid}` : "<uid>:<gid>";
    throw new Error(
      `[terrence] STORAGE_DIR is not writable: ${dir} (process uid:gid ${owner}). ` +
      `Fix volume ownership on the host, then restart: chown -R ${owner} ${dir} && chmod u+rwX ${dir}`,
    );
  }
}
