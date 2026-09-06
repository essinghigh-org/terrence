import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ensureBinary } from "../../src/binaryManager";
import { db } from "../../src/db";
import { storageDir } from "../../src/db/driver";
import { runs, stateVersions, workspaces } from "../../src/db/schema";
import { captureInterruptedApplyState, sweepIncompleteRecoveryCopies } from "../../src/lib/recovery-files";
import { stateTools } from "../../src/lib/mcp/state";
import { insertStateVersionWithSerialRetry } from "../../src/lib/state-serial";
import { CLIENT_ENCRYPTED_STATE_ERROR, encryptStatePayload, parseTerraformStatePayload } from "../../src/lib/validation";
import matrix from "../e2e/cli_matrix.json";
import { cleanupSeed, expectSuccessResponse, jsonHeaders, persistSeed, request, seedOrg } from "./compat_contract_helpers";

test("real OpenTofu encrypted state is rejected without losing the current state or recovery bytes", async () => {
  const seed = seedOrg("encrypted-state");
  const directory = await mkdtemp(join(tmpdir(), "terrence-encrypted-state-"));
  const workspaceId = `workspace-${seed.suffix}`;
  const runId = `run-${seed.suffix}`;
  const headers = jsonHeaders(seed.token);
  const recoveryDir = join(storageDir, "recovery", runId);
  try {
    const binary = await ensureBinary("tofu", matrix.tofu.current);
    if (binary === null) throw new Error("Could not obtain pinned OpenTofu");
    const cli = async (...args: string[]): Promise<{ code: number; out: string; err: string }> => {
      const child = Bun.spawn([binary.binaryPath, ...args], {
        cwd: directory,
        env: { PATH: process.env["PATH"], HOME: directory, CHECKPOINT_DISABLE: "1" },
        stdout: "pipe", stderr: "pipe", timeout: 30_000,
      });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, out, err };
    };
    const successful = async (...args: string[]): Promise<string> => {
      const result = await cli(...args);
      expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: "" });
      return result.out;
    };
    const config = async (mode: "old" | "wrong" | "missing" | "migrate" | "new"): Promise<void> => {
      const method = mode === "new" || mode === "migrate" ? "new" : "old";
      await writeFile(join(directory, "main.tf"), `terraform {
  ${mode === "missing" ? "" : `encryption {
    ${mode === "new" ? "" : `key_provider "pbkdf2" "old" { passphrase = "synthetic-${mode === "wrong" ? "wrong" : "old"}-key-0001" }
    method "aes_gcm" "old" { keys = key_provider.pbkdf2.old }`}
    ${mode === "new" || mode === "migrate" ? `key_provider "pbkdf2" "new" { passphrase = "synthetic-new-key-0002" }
    method "aes_gcm" "new" { keys = key_provider.pbkdf2.new }` : ""}
    state {
      method = method.aes_gcm.${method}
      enforced = true
      ${mode === "migrate" ? "fallback { method = method.aes_gcm.old }" : ""}
    }
  }`}
}
resource "terraform_data" "probe" { input = "synthetic-encrypted-value" }
output "probe" { value = terraform_data.probe.output }
`, { mode: 0o600 });
    };
    await config("old");
    await successful("init", "-input=false", "-no-color");
    await successful("apply", "-auto-approve", "-input=false", "-no-color");
    const original = await readFile(join(directory, "terraform.tfstate"), "utf8");
    expect(JSON.parse(original)).toMatchObject({ encryption_version: "v0" });
    expect(original).not.toContain("synthetic-encrypted-value");
    const plaintext = await successful("state", "pull");
    const parsed = JSON.parse(plaintext) as { serial: number; lineage: string };
    expect(parseTerraformStatePayload(plaintext)).not.toBeNull();
    for (const mode of ["wrong", "missing"] as const) {
      await config(mode);
      const failed = await cli("state", "pull");
      expect(failed.code).not.toBe(0);
      expect(failed.err.toLowerCase()).toContain(mode === "wrong" ? "decryption failed" : "encrypt");
      expect(await readFile(join(directory, "terraform.tfstate"), "utf8")).toBe(original);
    }
    await config("migrate");
    await successful("apply", "-auto-approve", "-input=false", "-no-color");
    const migrated = await readFile(join(directory, "terraform.tfstate"), "utf8");
    expect(migrated).not.toBe(original);
    await config("new");
    expect(JSON.parse(await successful("state", "pull"))).toMatchObject({ outputs: { probe: { value: "synthetic-encrypted-value" } } });
    await config("old");
    expect((await cli("state", "pull")).code).not.toBe(0);
    await config("new");

    await persistSeed(seed);
    await db.insert(workspaces).values({ id: workspaceId, name: "encrypted-state", orgId: seed.orgId });
    await db.insert(runs).values({ id: runId, workspaceId, status: "errored", createdAt: Date.now() });
    expect((await request(`/api/v2/workspaces/${workspaceId}/actions/lock`, { method: "POST", headers })).status).toBe(200);
    const create = (serial: number, payload: string, inline: boolean): Promise<Response> => request(`/api/v2/workspaces/${workspaceId}/state-versions`, {
      method: "POST", headers,
      body: JSON.stringify({ data: { type: "state-versions", attributes: { serial, lineage: parsed.lineage, md5: createHash("md5").update(payload).digest("hex"), ...(inline ? { state: payload } : {}) } } }),
    });
    const baseline = await expectSuccessResponse(await create(parsed.serial, plaintext, true), 201, "state-versions");
    const rejected = async (response: Response, status = 400): Promise<void> => {
      expect(response.status).toBe(status);
      expect((await response.json()).errors[0].detail).toBe(CLIENT_ENCRYPTED_STATE_ERROR);
    };
    for (const encrypted of [original, migrated]) {
      expect(parseTerraformStatePayload(encrypted)).toBeNull();
      // Adding familiar v4 metadata cannot disguise an encrypted envelope.
      expect(parseTerraformStatePayload(JSON.stringify({ ...JSON.parse(plaintext), ...JSON.parse(encrypted) }))).toBeNull();
      await rejected(await create(parsed.serial + 1, encrypted, true));
      await rejected(await request(`/api/v2/workspaces/${workspaceId}/state-versions/upload`, { method: "POST", headers, body: encrypted }));
      const reservation = await expectSuccessResponse(await create(parsed.serial + 1, encrypted, false), 201, "state-versions");
      await rejected(await request(reservation.attributes["hosted-state-upload-url"] as string, { method: "PUT", body: encrypted }));
      expect(await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, reservation.id) })).toMatchObject({ status: "pending", statePayload: null });
      expect((await request(`/api/v2/state-versions/${reservation.id}`, { method: "DELETE", headers })).status).toBe(204);
      let failure: unknown;
      try {
        // Both the local worker and modern agent persist through this shared boundary.
        await insertStateVersionWithSerialRetry({ id: crypto.randomUUID(), workspaceId, statePayload: await encryptStatePayload(encrypted) });
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(CLIENT_ENCRYPTED_STATE_ERROR);
      const current = await expectSuccessResponse(await request(`/api/v2/workspaces/${workspaceId}/current-state-version`, { headers }), 200, "state-versions");
      expect(current.id).toBe(baseline.id);
      expect(await (await request(`/api/v2/state-versions/${baseline.id}/download`, { headers })).text()).toBe(plaintext);
    }

    expect(await captureInterruptedApplyState(storageDir, runId, directory)).toBe(true);
    const downloaded = await request(`/api/v2/runs/${runId}/recovery-state`, { headers });
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe(migrated);
    const run = await expectSuccessResponse(await request(`/api/v2/runs/${runId}`, { headers }), 200, "runs");
    expect(run.attributes).toMatchObject({ "has-recovery-state": true, "recovery-state-format-supported": false, "recovery-state-representation": "opentofu-encrypted" });
    await rejected(await request(`/api/v2/runs/${runId}/actions/recover-state`, { method: "POST", headers }), 422);
    expect(await Bun.file(join(recoveryDir, ".recovered")).exists()).toBe(true);
    await rm(join(recoveryDir, ".recovered"));
    await sweepIncompleteRecoveryCopies(storageDir);
    expect(await Bun.file(join(recoveryDir, "terraform.tfstate")).exists()).toBe(true);
    expect(await Bun.file(join(recoveryDir, ".recovered")).exists()).toBe(false);

    // Older releases could journal this representation through worker/agent writes.
    const legacyId = `legacy-${seed.suffix}`;
    await db.insert(stateVersions).values({ id: legacyId, workspaceId, serial: parsed.serial + 10, statePayload: await encryptStatePayload(migrated), jsonState: await encryptStatePayload(migrated) });
    const legacy = await expectSuccessResponse(await request(`/api/v2/state-versions/${legacyId}`, { headers }), 200, "state-versions");
    expect(legacy.attributes).toMatchObject({ "state-representation": "opentofu-encrypted", "resources-processed": false, resources: null, "hosted-json-state-download-url": null });
    for (const path of [`/workspaces/${workspaceId}/resources`, `/workspaces/${workspaceId}/dependency-graph`, `/workspaces/${workspaceId}/current-state-version-outputs`, `/state-versions/${legacyId}/outputs`, `/state-versions/${legacyId}/state-version-outputs`, `/state-versions/${legacyId}/json-download`]) {
      await rejected(await request(`/api/v2${path}`, { headers }), 422);
    }
    await rejected(await request(`/api/v2/state-versions/${legacyId}/actions/rollback`, { method: "POST", headers }), 422);
    const workspace = await expectSuccessResponse(await request(`/api/v2/workspaces/${workspaceId}?include=outputs`, { headers }), 200, "workspaces");
    expect(workspace.relationships?.["outputs"]).toMatchObject({ data: null, meta: { "unavailable-reason": CLIENT_ENCRYPTED_STATE_ERROR } });
    const stateTool = stateTools.find((tool) => tool.name === "get_workspace_state");
    expect(stateTool).toBeDefined();
    const mcpState = await stateTool!.handler({ userId: seed.userId, orgId: null, teamId: null, tokenId: seed.tokenId, scopes: null }, { workspace_id: workspaceId });
    expect(JSON.stringify(mcpState)).toContain(CLIENT_ENCRYPTED_STATE_ERROR);
    const raw = await (await request(`/api/v2/state-versions/${legacyId}/download`, { headers })).text();
    expect(raw).toBe(migrated);
    await writeFile(join(directory, "terraform.tfstate"), raw, { mode: 0o600 });
    await successful("plan", "-input=false", "-no-color", "-detailed-exitcode");
  } finally {
    await db.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
    await db.delete(runs).where(eq(runs.id, runId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await cleanupSeed(seed);
    await rm(directory, { recursive: true, force: true });
    await rm(recoveryDir, { recursive: true, force: true });
  }
}, 180_000);
