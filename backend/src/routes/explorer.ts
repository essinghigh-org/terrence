import { Elysia } from "elysia";
import { db } from "../db";
import { organizations, workspaces, type users } from "../db/schema";
import { eq, desc, count } from "drizzle-orm";
import { authPlugin } from "../auth";
import { checkOrgPermission, pageRequest, pagination } from "../lib/utils";

type SetObj = Readonly<{ status?: number | string; headers: Record<string, string | number> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  request: Readonly<{ url: string }>;
  set: SetObj;
}>;

export const explorerRoutes = new Elysia({ name: "explorer" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/explorer", async ({ params, user, request, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const url = new URL(request.url);
    const viewType = url.searchParams.get("type") ?? "workspaces";
    const { number, size } = pageRequest(request);

    if (viewType === "workspaces") {
      const total = (await db.select({ value: count() }).from(workspaces).where(eq(workspaces.orgId, org.id)))[0]?.value ?? 0;
      const list = await db.query.workspaces.findMany({
        where: eq(workspaces.orgId, org.id),
        orderBy: [desc(workspaces.createdAt)],
        offset: (number - 1) * size,
        limit: size,
      });

      const resources = list.map((w) => ({
        id: w.id,
        type: "explorer-workspaces",
        attributes: {
          name: w.name,
          "terraform-version": w.terraformVersion,
          "execution-mode": w.executionMode,
          "created-at": new Date(w.createdAt).toISOString(),
          "updated-at": new Date(w.updatedAt).toISOString(),
        },
      }));

      return { data: resources, ...pagination(request, number, size, total) };
    }

    return { data: [], ...pagination(request, number, size, 0) };
  })
  .get("/api/v1/nodes", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined || user.isSiteAdmin !== true) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: [
        {
          id: "terrence-node-1",
          type: "nodes",
          attributes: {
            hostname: "terrence-primary",
            active: true,
            "created-at": new Date().toISOString(),
          },
        },
      ],
    };
  });
