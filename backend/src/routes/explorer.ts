import { Elysia } from "elysia";
import { db } from "../db";
import { organizations, workspaces, projects, workspaceTags, stateVersions, runs, type users } from "../db/schema";
import { eq, desc, count, inArray } from "drizzle-orm";
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

function safeIsoDate(val: unknown): string {
  if (val === null || val === undefined || val === "") return new Date().toISOString();
  const d = new Date(val as string | number);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

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

      const wsIds = list.map((w) => w.id);
      const projIds = [...new Set(list.map((w) => w.projectId).filter((id): id is string => id !== null))];

      const [allProjects, allTags, latestStates, latestRuns] = await Promise.all([
        projIds.length > 0 ? db.query.projects.findMany({ where: inArray(projects.id, projIds) }) : Promise.resolve([]),
        wsIds.length > 0 ? db.query.workspaceTags.findMany({ where: inArray(workspaceTags.workspaceId, wsIds) }) : Promise.resolve([]),
        wsIds.length > 0 ? db.query.stateVersions.findMany({ where: inArray(stateVersions.workspaceId, wsIds), orderBy: [desc(stateVersions.serial)] }) : Promise.resolve([]),
        wsIds.length > 0 ? db.query.runs.findMany({ where: inArray(runs.workspaceId, wsIds), orderBy: [desc(runs.createdAt)] }) : Promise.resolve([]),
      ]);

      const projectsById = new Map(allProjects.map((p) => [p.id, p]));
      const tagsByWs = new Map<string, string[]>();
      for (const t of allTags) {
        const arr = tagsByWs.get(t.workspaceId) ?? [];
        arr.push(t.key);
        tagsByWs.set(t.workspaceId, arr);
      }

      const latestStateByWs = new Map<string, typeof stateVersions.$inferSelect>();
      for (const sv of latestStates) {
        if (!latestStateByWs.has(sv.workspaceId)) latestStateByWs.set(sv.workspaceId, sv);
      }

      const latestRunByWs = new Map<string, typeof runs.$inferSelect>();
      for (const r of latestRuns) {
        if (!latestRunByWs.has(r.workspaceId)) latestRunByWs.set(r.workspaceId, r);
      }

      const resources = list.map((w) => {
        const proj = w.projectId ? projectsById.get(w.projectId) : undefined;
        const sv = latestStateByWs.get(w.id);
        const r = latestRunByWs.get(w.id);
        const vcsObj = typeof w.vcsRepo === "object" && w.vcsRepo !== null ? (w.vcsRepo as Record<string, unknown>) : {};

        return {
          id: w.id,
          type: "workspaces",
          attributes: {
            organization_name: org.name,
            workspace_name: w.name,
            name: w.name,
            workspace_created_at: safeIsoDate(w.createdAt),
            workspace_updated_at: safeIsoDate((w as Record<string, unknown>).updatedAt as number),
            "terraform-version": w.terraformVersion,
            "execution-mode": w.executionMode,
            current_run_status: r?.status ?? null,
            current_run_applied_at: (r as Record<string, unknown> | undefined)?.appliedAt ? safeIsoDate((r as Record<string, unknown>).appliedAt as number) : null,
            current_run_external_id: r?.id ?? null,
            current_rum_count: 0,
            drifted: false,
            resources_drifted: 0,
            resources_undrifted: 0,
            all_checks_succeeded: true,
            checks_passed: 0,
            checks_failed: 0,
            checks_errored: 0,
            checks_unknown: 0,
            vcs_repo_identifier: typeof vcsObj.identifier === "string" ? vcsObj.identifier : null,
            tags: (tagsByWs.get(w.id) ?? []).join(", "),
            project_name: proj?.name ?? "Default Project",
            project_external_id: proj?.id ?? null,
            provider_count: 0,
            module_count: 0,
            state_version_terraform_version: (sv as Record<string, unknown> | undefined)?.terraformVersion ?? (w as Record<string, unknown>).terraformVersion,
            source_module_id: null,
            "created-at": safeIsoDate(w.createdAt),
            "updated-at": safeIsoDate((w as Record<string, unknown>).updatedAt as number),
          },
        };
      });

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
      data: ["terrence-node-1"],
      links: { self: "/api/v1/nodes" },
    };
  });
