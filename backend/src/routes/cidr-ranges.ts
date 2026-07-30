import { Elysia } from "elysia";
import { db } from "../db";
import { cidrRangeLists, cidrRanges, organizations, type users } from "../db/schema";
import { eq, desc, count } from "drizzle-orm";
import { authPlugin } from "../auth";
import { checkOrgPermission, pageRequest, pagination } from "../lib/utils";

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

async function cidrRangeListResource(list: CidrRangeListItem): Promise<Record<string, unknown>> {
  const ranges = await db.query.cidrRanges.findMany({ where: eq(cidrRanges.cidrRangeListId, list.id) });
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
      organization: { data: { id: list.orgId, type: "organizations" } },
      "cidr-ranges": { data: ranges.map((r) => ({ id: r.id, type: "cidr-ranges" })) },
    },
  };
}

function cidrRangeResource(range: CidrRangeItem): Record<string, unknown> {
  return {
    id: range.id,
    type: "cidr-ranges",
    attributes: {
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
    const list: CidrRangeListItem = {
      id,
      orgId: org.id,
      name,
      description: typeof attributes.description === "string" ? attributes.description : null,
      enforcementScope: typeof attributes["enforcement-scope"] === "string" ? attributes["enforcement-scope"] : "organization",
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
    if (typeof attributes["enforcement-scope"] === "string") updates.enforcementScope = attributes["enforcement-scope"];

    await db.update(cidrRangeLists).set(updates).where(eq(cidrRangeLists.id, list.id));
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
    const value = typeof attributes.value === "string" ? attributes.value.trim() : "";
    if (value === "") {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "value is required" }] };
    }
    const id = `cr-${crypto.randomUUID()}`;
    const range: CidrRangeItem = {
      id,
      cidrRangeListId: list.id,
      value,
      description: typeof attributes.description === "string" ? attributes.description : null,
      createdAt: Date.now(),
    };
    await db.insert(cidrRanges).values(range);
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
    if (typeof attributes.value === "string" && attributes.value.trim() !== "") updates.value = attributes.value.trim();
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
  });
