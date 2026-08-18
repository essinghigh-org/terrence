import { Elysia } from "elysia";
import { db } from "../db";
import { agentPools, cidrRangeListAgentPools, cidrRangeLists, cidrRanges, organizations, type users } from "../db/schema";
import { and, eq, desc, count, inArray } from "drizzle-orm";
import { isIP } from "node:net";
import { authPlugin } from "../auth";
import { checkOrgPermission, pageRequest, pagination } from "../lib/utils";
import { organizationName } from "../lib/response";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

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

type CidrRangeListItem = Readonly<typeof cidrRangeLists.$inferSelect>;
type CidrRangeItem = Readonly<typeof cidrRanges.$inferSelect>;

const enforcementScopes = new Set(["organization", "all_agent_pools", "selected_agent_pools"]);

function isCidrBlock(value: string): boolean {
  const [address, prefix, ...extra] = value.split("/");
  if (extra.length > 0 || address === undefined || prefix === undefined || !/^\d+$/.test(prefix)) return false;
  const version = isIP(address);
  const maxPrefix = version === 4 ? 32 : version === 6 ? 128 : -1;
  const numericPrefix = Number(prefix);
  return maxPrefix >= 0 && numericPrefix <= maxPrefix;
}

async function createCidrRange(listId: string, attributes: Record<string, unknown>): Promise<CidrRangeItem | "invalid" | undefined> {
  const rawValue = typeof attributes["cidr-block"] === "string"
    ? attributes["cidr-block"].trim()
    : typeof attributes.value === "string" ? attributes.value.trim() : "";
  if (rawValue === "") return undefined;
  if (!isCidrBlock(rawValue)) return "invalid";
  const range: CidrRangeItem = {
    id: `cr-${crypto.randomUUID()}`,
    cidrRangeListId: listId,
    value: rawValue,
    description: typeof attributes.description === "string" ? attributes.description : null,
    createdAt: Date.now(),
  };
  await db.insert(cidrRanges).values(range);
  return range;
}

async function cidrRangeListResource(list: CidrRangeListItem): Promise<Record<string, unknown>> {
  const [ranges, poolLinks] = await Promise.all([
    db.query.cidrRanges.findMany({ where: eq(cidrRanges.cidrRangeListId, list.id) }),
    db.query.cidrRangeListAgentPools.findMany({ where: eq(cidrRangeListAgentPools.cidrRangeListId, list.id) }),
  ]);
  return {
    id: list.id,
    type: "cidr-range-lists",
    attributes: {
      name: list.name,
      description: list.description,
      "enforcement-scope": list.enforcementScope,
      "created-at": new Date(list.createdAt).toISOString(),
      "updated-at": new Date(list.updatedAt).toISOString(),
    },
    relationships: {
      organization: { data: { id: (await organizationName(list.orgId)) ?? list.orgId, type: "organizations" } },
      "cidr-ranges": { data: ranges.map((r) => ({ id: r.id, type: "cidr-ranges" })) },
      "agent-pools": { data: poolLinks.map((link) => ({ id: link.agentPoolId, type: "agent-pools" })) },
    },
    links: { self: `/api/v2/cidr-range-lists/${list.id}` },
  };
}

function cidrRangeResource(range: CidrRangeItem): Record<string, unknown> {
  return {
    id: range.id,
    type: "cidr-ranges",
    attributes: {
      "cidr-block": range.value,
      value: range.value,
      description: range.description,
      "created-at": new Date(range.createdAt).toISOString(),
    },
    relationships: {
      "cidr-range-list": { data: { id: range.cidrRangeListId, type: "cidr-range-lists" } },
    },
  };
}

export const cidrRangeRoutes = new Elysia({ name: "cidr-ranges" })
  .use(authPlugin)
  // CIDR Range Lists
  .get("/api/v2/organizations/:org_name/cidr-range-lists", async ({ params, user, request, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const total = (await db.select({ value: count() }).from(cidrRangeLists).where(eq(cidrRangeLists.orgId, org.id)))[0]?.value ?? 0;
    const lists = await db.query.cidrRangeLists.findMany({
      where: eq(cidrRangeLists.orgId, org.id),
      orderBy: [desc(cidrRangeLists.createdAt)],
      offset: (number - 1) * size,
      limit: size,
    });
    return { data: await Promise.all(lists.map(async (l) => cidrRangeListResource(l))), ...pagination(request, number, size, total) };
  })
  .post("/api/v2/organizations/:org_name/cidr-range-lists", async ({ params, user, body, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkOrgPermission(user?.id, org.id, "owner", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = (data?.attributes as Record<string, unknown>) ?? {};
    const name = typeof attributes.name === "string" ? attributes.name.trim() : "";
    if (name === "") {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "name is required" }] };
    }
    const id = `crl-${crypto.randomUUID()}`;
    const enforcementScope = typeof attributes["enforcement-scope"] === "string" ? attributes["enforcement-scope"] : "organization";
    if (!enforcementScopes.has(enforcementScope)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "enforcement-scope is invalid" }] };
    }
    const list: CidrRangeListItem = {
      id,
      orgId: org.id,
      name,
      description: typeof attributes.description === "string" ? attributes.description : null,
      enforcementScope,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await db.insert(cidrRangeLists).values(list);
    (set as { status: number }).status = 201;
    return { data: await cidrRangeListResource(list) };
  })
  .get("/api/v2/cidr-range-lists/:id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const list = await db.query.cidrRangeLists.findFirst({ where: eq(cidrRangeLists.id, params.id ?? "") });
    if (list === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkOrgPermission(user?.id, list.orgId, "member", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: await cidrRangeListResource(list) };
  })
  .patch("/api/v2/cidr-range-lists/:id", async ({ params, user, body, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const list = await db.query.cidrRangeLists.findFirst({ where: eq(cidrRangeLists.id, params.id ?? "") });
    if (list === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkOrgPermission(user?.id, list.orgId, "owner", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = (data?.attributes as Record<string, unknown>) ?? {};
    const updates: Record<string, unknown> = { updatedAt: Date.now() };
    if (typeof attributes.name === "string" && attributes.name.trim() !== "") updates.name = attributes.name.trim();
    if (typeof attributes.description === "string") updates.description = attributes.description;
    if (typeof attributes["enforcement-scope"] === "string") {
      if (!enforcementScopes.has(attributes["enforcement-scope"])) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "enforcement-scope is invalid" }] };
      }
      updates.enforcementScope = attributes["enforcement-scope"];
    }

    await db.transaction(async (tx) => {
      await tx.update(cidrRangeLists).set(updates).where(eq(cidrRangeLists.id, list.id));
      if (updates.enforcementScope === "organization" || updates.enforcementScope === "all_agent_pools") {
        await tx.delete(cidrRangeListAgentPools).where(eq(cidrRangeListAgentPools.cidrRangeListId, list.id));
      }
    });
    const updated = await db.query.cidrRangeLists.findFirst({ where: eq(cidrRangeLists.id, list.id) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: await cidrRangeListResource(updated) };
  })
  .delete("/api/v2/cidr-range-lists/:id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const list = await db.query.cidrRangeLists.findFirst({ where: eq(cidrRangeLists.id, params.id ?? "") });
    if (list === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkOrgPermission(user?.id, list.orgId, "owner", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(cidrRangeLists).where(eq(cidrRangeLists.id, list.id));
    (set as { status: number }).status = 204;
    return {};
  })

  // CIDR Ranges
  .get("/api/v2/cidr-ranges", async ({ request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const listId = new URL(request.url).searchParams.get("filter[cidr-range-list][id]");
    if (typeof listId !== "string" || listId === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "filter[cidr-range-list][id] filter is required" }] };
    }
    const list = await db.query.cidrRangeLists.findFirst({ where: eq(cidrRangeLists.id, listId) });
    if (list === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkOrgPermission(user?.id, list.orgId, "member", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ranges = await db.query.cidrRanges.findMany({ where: eq(cidrRanges.cidrRangeListId, list.id) });
    return { data: ranges.map((r) => cidrRangeResource(r)) };
  })
  .post("/api/v2/cidr-ranges", async ({ body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = (data?.attributes as Record<string, unknown>) ?? {};
    const rels = (data?.relationships as Record<string, unknown>) ?? {};
    const listRel = rels["cidr-range-list"] as Record<string, unknown> | undefined;
    const listId = typeof (listRel?.data as Record<string, unknown>)?.id === "string" ? ((listRel?.data as Record<string, unknown>).id as string) : "";

    const list = await db.query.cidrRangeLists.findFirst({ where: eq(cidrRangeLists.id, listId) });
    if (list === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!(await checkOrgPermission(user?.id, list.orgId, "owner", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const range = await createCidrRange(list.id, attributes);
    if (range === undefined || range === "invalid") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: range === undefined ? "cidr-block is required" : "cidr-block must be a valid CIDR block" }] };
    }
    (set as { status: number }).status = 201;
    return { data: cidrRangeResource(range) };
  })
  .get("/api/v2/cidr-ranges/:id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const range = await db.query.cidrRanges.findFirst({ where: eq(cidrRanges.id, params.id ?? "") });
    if (range === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const list = await db.query.cidrRangeLists.findFirst({ where: eq(cidrRangeLists.id, range.cidrRangeListId) });
    if (list === undefined || !(await checkOrgPermission(user?.id, list.orgId, "member", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: cidrRangeResource(range) };
  })
  .patch("/api/v2/cidr-ranges/:id", async ({ params, user, body, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const range = await db.query.cidrRanges.findFirst({ where: eq(cidrRanges.id, params.id ?? "") });
    if (range === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const list = await db.query.cidrRangeLists.findFirst({ where: eq(cidrRangeLists.id, range.cidrRangeListId) });
    if (list === undefined || !(await checkOrgPermission(user?.id, list.orgId, "owner", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = (data?.attributes as Record<string, unknown>) ?? {};
    const updates: Record<string, unknown> = {};
    const cidrBlock = typeof attributes["cidr-block"] === "string"
      ? attributes["cidr-block"].trim()
      : typeof attributes.value === "string" ? attributes.value.trim() : "";
    if (cidrBlock !== "") {
      if (!isCidrBlock(cidrBlock)) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "cidr-block must be a valid CIDR block" }] };
      }
      updates.value = cidrBlock;
    }
    if (typeof attributes.description === "string") updates.description = attributes.description;

    await db.update(cidrRanges).set(updates).where(eq(cidrRanges.id, range.id));
    const updated = await db.query.cidrRanges.findFirst({ where: eq(cidrRanges.id, range.id) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: cidrRangeResource(updated) };
  })
  .delete("/api/v2/cidr-ranges/:id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const range = await db.query.cidrRanges.findFirst({ where: eq(cidrRanges.id, params.id ?? "") });
    if (range === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const list = await db.query.cidrRangeLists.findFirst({ where: eq(cidrRangeLists.id, range.cidrRangeListId) });
    if (list === undefined || !(await checkOrgPermission(user?.id, list.orgId, "owner", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(cidrRanges).where(eq(cidrRanges.id, range.id));
    (set as { status: number }).status = 204;
    return {};
  })

  .get("/api/v2/cidr-range-lists/:id/relationships/cidr-ranges", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const list = await db.query.cidrRangeLists.findFirst({ where: eq(cidrRangeLists.id, params.id ?? "") });
    if (list === undefined || !(await checkOrgPermission(user?.id, list.orgId, "member", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ranges = await db.query.cidrRanges.findMany({ where: eq(cidrRanges.cidrRangeListId, list.id) });
    return { data: ranges.map((range) => cidrRangeResource(range)) };
  })
  .post("/api/v2/cidr-range-lists/:id/relationships/cidr-ranges", async ({ params, user, body, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const list = await db.query.cidrRangeLists.findFirst({ where: eq(cidrRangeLists.id, params.id ?? "") });
    if (list === undefined || !(await checkOrgPermission(user?.id, list.orgId, "owner", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = (data?.attributes as Record<string, unknown>) ?? {};
    const range = await createCidrRange(list.id, attributes);
    if (range === undefined || range === "invalid") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: range === undefined ? "cidr-block is required" : "cidr-block must be a valid CIDR block" }] };
    }
    (set as { status: number }).status = 201;
    return { data: cidrRangeResource(range) };
  })
  .post("/api/v2/cidr-range-lists/:id/relationships/agent-pools", async ({ params, user, body, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const list = await db.query.cidrRangeLists.findFirst({ where: eq(cidrRangeLists.id, params.id ?? "") });
    if (list === undefined || !(await checkOrgPermission(user?.id, list.orgId, "owner", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (list.enforcementScope !== "selected_agent_pools") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "agent pools are only valid for selected_agent_pools lists" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data;
    if (!Array.isArray(data)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data must be an array" }] };
    }
    const parsedPoolIds = data.flatMap((item): string[] => {
      if (typeof item !== "object" || item === null) return [];
      const resource = item as Record<string, unknown>;
      return resource.type === "agent-pools" && typeof resource.id === "string" ? [resource.id] : [];
    });
    if (parsedPoolIds.length !== data.length) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data must contain agent-pools resource identifiers" }] };
    }
    const poolIds = [...new Set(parsedPoolIds)];
    const pools = poolIds.length === 0 ? [] : await db.query.agentPools.findMany({ where: and(eq(agentPools.orgId, list.orgId), inArray(agentPools.id, poolIds)) });
    if (pools.length !== poolIds.length) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "agent pools must belong to the organization" }] };
    }
    const relationResult = await db.transaction(async (tx): Promise<"missing" | "invalid" | "ok"> => {
      const current = await tx.query.cidrRangeLists.findFirst({ where: eq(cidrRangeLists.id, list.id) });
      if (current === undefined) return "missing";
      if (current.enforcementScope !== "selected_agent_pools") return "invalid";
      if (poolIds.length > 0) {
        await tx.insert(cidrRangeListAgentPools).values(poolIds.map((agentPoolId) => ({
          id: `crlap-${crypto.randomUUID()}`,
          cidrRangeListId: list.id,
          agentPoolId,
        }))).onConflictDoNothing();
      }
      return "ok";
    });
    if (relationResult === "missing") {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (relationResult === "invalid") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "agent pools are only valid for selected_agent_pools lists" }] };
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/cidr-range-lists/:id/relationships/agent-pools", async ({ params, user, body, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const list = await db.query.cidrRangeLists.findFirst({ where: eq(cidrRangeLists.id, params.id ?? "") });
    if (list === undefined || !(await checkOrgPermission(user?.id, list.orgId, "owner", tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data;
    if (!Array.isArray(data)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data must be an array" }] };
    }
    const parsedPoolIds = data.flatMap((item): string[] => {
      if (typeof item !== "object" || item === null) return [];
      const resource = item as Record<string, unknown>;
      return resource.type === "agent-pools" && typeof resource.id === "string" ? [resource.id] : [];
    });
    if (parsedPoolIds.length !== data.length) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data must contain agent-pools resource identifiers" }] };
    }
    const poolIds = [...new Set(parsedPoolIds)];
    if (poolIds.length > 0) {
      await db.delete(cidrRangeListAgentPools).where(and(eq(cidrRangeListAgentPools.cidrRangeListId, list.id), inArray(cidrRangeListAgentPools.agentPoolId, poolIds)));
    }
    (set as { status: number }).status = 204;
    return {};
  });
