import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { apiTokens, runs, workspaces } from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { deletePlanJsonArtifact, writePlanJsonArtifact } from "../../src/lib/plan-json";
import {
  cleanupSeed,
  persistSeed,
  request,
  seedOrg,
} from "./compat_contract_helpers";

/**
 * MCP run/plan surface: get_run includes, create_run save-plan passthrough,
 * and the sanitized get_plan_json tool. All new surface stays inside existing
 * grants (runs:read / runs:plan) and re-authorizes per call, so fine-grained
 * tokens cannot reach other workspaces.
 */
describe("mcp run plan surface", () => {
  const seed = seedOrg("mcprun");
  const workspaceId = `ws-${seed.suffix}`;
  const otherWorkspaceId = `ws-other-${seed.suffix}`;
  const runId = `run-${seed.suffix}`;
  const scopedTokenId = `tok-mcprun-${seed.suffix}`;
  const scopedSecret = `secret-mcprun-${seed.suffix}`;

  const mcpCall = async (secret: string, name: string, args: Record<string, unknown>, id = 1): Promise<Response> =>
    request("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    });

  const mcpResult = async (res: Response): Promise<unknown> => {
    expect(res.status).toBe(200);
    const body = await res.json() as { result?: { content?: { text?: string }[] }; error?: { code: number; message: string } };
    if (body.error !== undefined) throw new Error(`MCP error ${body.error.code}: ${body.error.message}`);
    return JSON.parse(body.result?.content?.[0]?.text ?? "null");
  };

  const mcpTools = async (secret: string): Promise<string[]> => {
    const res = await request("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { tools: { name: string }[] } };
    return body.result.tools.map((t): string => t.name);
  };

  beforeAll(async () => {
    await persistSeed(seed);
    await db.insert(workspaces).values([
      { id: workspaceId, name: "mcp-run-ws", orgId: seed.orgId, autoApply: false, terraformVersion: "latest" },
      { id: otherWorkspaceId, name: "mcp-run-ws-other", orgId: seed.orgId, autoApply: false, terraformVersion: "latest" },
    ]);
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "planned",
      message: "mcp run surface",
      createdAt: Date.now(),
    });
    await writePlanJsonArtifact(runId, {
      format_version: "1.2",
      terraform_version: "1.9.8",
      values: { secret: "sensitive-value", secret_sensitive: true },
    });
    await db.insert(apiTokens).values({
      id: scopedTokenId,
      token: hashAuthenticationToken(scopedSecret),
      userId: seed.userId,
      scopes: JSON.stringify({
        version: 1,
        orgs: [seed.orgId],
        projects: null,
        workspaces: [workspaceId],
        tags: null,
        permissions: { "runs:read": true },
      }),
    });
  });

  afterAll(async () => {
    await deletePlanJsonArtifact(runId).catch(() => undefined);
    await db.delete(apiTokens).where(eq(apiTokens.id, scopedTokenId));
    await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId));
    await cleanupSeed(seed);
  });

  it("exposes run reads and plan JSON to runs:read tokens, but not run creation", async () => {
    const names = await mcpTools(scopedSecret);
    expect(names).toContain("get_run");
    expect(names).toContain("get_plan_json");
    expect(names).not.toContain("create_run");
    expect(names).not.toContain("apply_run");
  });

  it("returns plan and workspace includes for a single run", async () => {
    const body = await mcpResult(await mcpCall(scopedSecret, "get_run", {
      workspace_id: workspaceId,
      run_id: runId,
      include: "plan,workspace",
    })) as {
      id?: string;
      status?: string;
      included?: { plan?: { id?: string; status?: string }; workspace?: { id?: string; name?: string; locked?: boolean } };
    };
    expect(body.id).toBe(runId);
    expect(body.status).toBe("planned");
    expect(body.included?.plan).toMatchObject({ id: `plan-${runId}`, status: "finished" });
    expect(body.included?.workspace).toMatchObject({ id: workspaceId, name: "mcp-run-ws" });
  });

  it("omits includes when not requested", async () => {
    const body = await mcpResult(await mcpCall(scopedSecret, "get_run", {
      workspace_id: workspaceId,
      run_id: runId,
    })) as { id?: string; included?: unknown };
    expect(body.id).toBe(runId);
    expect(body.included).toBeUndefined();
  });

  it("returns the sanitized plan JSON with secrets redacted", async () => {
    const body = await mcpResult(await mcpCall(scopedSecret, "get_plan_json", { run_id: runId })) as {
      run_id?: string;
      plan?: { values?: { secret?: unknown }; terraform_version?: string };
    };
    expect(body.run_id).toBe(runId);
    expect(body.plan?.terraform_version).toBe("1.9.8");
    expect(body.plan?.values?.secret).toBeNull();
  });

  it("denies plan JSON for runs outside the token's workspaces", async () => {
    const foreignRunId = `run-foreign-${seed.suffix}`;
    await db.insert(runs).values({
      id: foreignRunId,
      workspaceId: otherWorkspaceId,
      status: "planned",
      message: "foreign",
      createdAt: Date.now(),
    });
    try {
      const denied = await mcpCall(scopedSecret, "get_plan_json", { run_id: foreignRunId });
      expect(denied.status).toBe(200);
      const deniedBody = await denied.json() as { error?: { code: number } };
      expect(deniedBody.error?.code).toBe(-32001);
    } finally {
      await db.delete(runs).where(eq(runs.id, foreignRunId));
    }
  });

  it("reports unavailable plan JSON for runs without an artifact", async () => {
    const emptyRunId = `run-empty-${seed.suffix}`;
    await db.insert(runs).values({
      id: emptyRunId,
      workspaceId,
      status: "planned",
      message: "no artifact",
      createdAt: Date.now(),
    });
    try {
      const res = await mcpCall(seed.token, "get_plan_json", { run_id: emptyRunId });
      expect(res.status).toBe(200);
      const body = await res.json() as { error?: { code: number; message: string } };
      expect(body.error?.code).toBe(-32602);
      expect(body.error?.message).toBe("Plan JSON output is unavailable for this run");
    } finally {
      await db.delete(runs).where(eq(runs.id, emptyRunId));
    }
  });

  it("passes save-plan through on run creation", async () => {
    const body = await mcpResult(await mcpCall(seed.token, "create_run", {
      workspace_id: workspaceId,
      message: "mcp save-plan",
      "save-plan": true,
    })) as { id?: string };
    const createdId = body.id;
    expect(createdId).toBeTypeOf("string");
    try {
      const row = await db.query.runs.findFirst({ where: eq(runs.id, createdId!) });
      expect(row?.savePlan).toBe(true);
    } finally {
      if (createdId !== undefined) await db.delete(runs).where(eq(runs.id, createdId));
    }
  });
});
