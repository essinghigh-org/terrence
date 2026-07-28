import { Elysia } from "elysia";
import { and, eq } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import { githubAppInstallations, organizations, type users } from "../db/schema";
import { checkOrgPermission } from "../lib/utils";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;
type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  set: SetObj;
}>;

function installationResource(installation: Readonly<typeof githubAppInstallations.$inferSelect>): Record<string, unknown> {
  return {
    id: installation.id,
    type: "github-app-installations",
    attributes: {
      name: installation.name,
      "installation-id": installation.installationId,
      "icon-url": installation.iconUrl,
      "installation-type": installation.installationType,
      "installation-url": installation.installationUrl,
      "created-at": new Date(installation.createdAt).toISOString(),
    },
  };
}

export const githubAppInstallationRoutes = new Elysia({ name: "githubAppInstallations" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/github-app/installations", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params["org_name"] ?? "") });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const installations = await db.query.githubAppInstallations.findMany({
      where: eq(githubAppInstallations.orgId, org.id),
    });
    return { data: installations.map(installationResource) };
  })
  .post("/api/v2/organizations/:org_name/github-app/installations", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params["org_name"] ?? "") });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload["data"] !== null && typeof payload["data"] === "object" ? payload["data"] as Record<string, unknown> : {};
    const attributes = data["attributes"] !== null && typeof data["attributes"] === "object" ? data["attributes"] as Record<string, unknown> : {};
    const name = typeof attributes["name"] === "string" ? attributes["name"].trim() : "";
    const installationId = attributes["installation-id"];
    if (name === "" || typeof installationId !== "number" || !Number.isSafeInteger(installationId) || installationId <= 0) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name and a positive integer installation ID are required" }] };
    }
    const existing = await db.query.githubAppInstallations.findFirst({
      where: and(eq(githubAppInstallations.orgId, org.id), eq(githubAppInstallations.installationId, installationId)),
    });
    if (existing !== undefined) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Installation ID is already registered in this organization" }] };
    }
    const installation = {
      id: `ghain-${crypto.randomUUID()}`,
      orgId: org.id,
      name,
      installationId,
      createdAt: Date.now(),
    };
    await db.insert(githubAppInstallations).values(installation);
    (set as { status: number }).status = 201;
    return { data: installationResource({ ...installation, iconUrl: null, installationType: "Organization", installationUrl: null }) };
  });
