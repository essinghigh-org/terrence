import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { apiTokens, users } from "../db/schema";

/**
 * Internal API token for the run worker's terraform/opentofu processes.
 *
 * Runs execute with a LOCAL backend (the worker manages state itself), so
 * terraform never gets the user-supplied credentials file. Registry module
 * resolution (and any host API call) then fails authentication. This mints a
 * token bound to a site admin at boot and hands it to the worker via
 * TF_TOKEN_<hostname>, the terraform-native credentials env var.
 */
let cachedToken: string | null = null;

export async function ensureInternalApiToken(): Promise<string> {
  if (cachedToken !== null) return cachedToken;
  // Replace any previous internal token (each boot rotates it).
  await db.delete(apiTokens).where(eq(apiTokens.description, "internal worker token"));
  const admin = await db.query.users.findFirst({ where: eq(users.isSiteAdmin, true) });
  if (admin === undefined) {
    throw new Error("No site admin user exists to bind the internal worker token");
  }
  const token = `itok-${randomUUID()}`;
  await db.insert(apiTokens).values({
    id: `apitok-${randomUUID()}`,
    token: createHash("sha256").update(token).digest("hex"),
    userId: admin.id,
    description: "internal worker token",
    createdAt: Date.now(),
  });
  cachedToken = token;
  return cachedToken;
}
