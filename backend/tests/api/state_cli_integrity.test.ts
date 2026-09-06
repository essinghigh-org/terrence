import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ensureBinary } from "../../src/binaryManager";
import { db } from "../../src/db";
import { storageDir } from "../../src/db/driver";
import { runs, stateVersions, workspaces } from "../../src/db/schema";
import { cleanupSeed, expectSuccessResponse, jsonHeaders, persistSeed, request, seedOrg, type JsonApiResource } from "./compat_contract_helpers";

// API writes target the isolated test DB. CLI commands only inspect local
// downloaded state and compute a plan; no apply, state push or cloud provider.
for (const engine of ["terraform", "tofu"] as const) {
  describe(`${engine} downloaded state integrity`, () => {
    const seed = seedOrg(`cli-${engine}`);
    const workspaceId = `workspace-${seed.suffix}`;
    const runId = `run-${seed.suffix}`;
    const headers = jsonHeaders(seed.token);
    let directory = "";

    afterAll(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
      await rm(join(storageDir, "recovery", runId), { recursive: true, force: true });
      await db.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
      await db.delete(runs).where(eq(runs.id, runId));
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await cleanupSeed(seed);
    });

    it("reads inline, deferred, rollback and recovery bytes with matching serial, digest and outputs", async () => {
      const binary = Bun.which(engine) ?? (await ensureBinary(engine))?.binaryPath;
      if (!binary) throw new Error(`Could not obtain ${engine}`);
      directory = await mkdtemp(join(tmpdir(), "terrence-state-cli-"));
      const cli = async (...args: string[]): Promise<string> => {
        const child = Bun.spawn([binary, ...args], {
          cwd: directory,
          env: { PATH: process.env["PATH"], HOME: directory, TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" },
          stdout: "pipe", stderr: "pipe", timeout: 30_000,
        });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        return stdout;
      };
      await persistSeed(seed);
      await db.insert(workspaces).values({ id: workspaceId, name: "state-cli", orgId: seed.orgId });
      await db.insert(runs).values({ id: runId, workspaceId, status: "planned", createdAt: Date.now() });
      expect((await request(`/api/v2/workspaces/${workspaceId}/actions/lock`, { method: "POST", headers })).status).toBe(200);
      const state = (serial: number, value: string): string => JSON.stringify({
        version: 4, terraform_version: "1.5.0", serial, lineage: seed.suffix,
        outputs: { sample: { value, type: "string" }, secret: { value: "SYNTHETIC_CLI_SECRET", type: "string", sensitive: true } },
        resources: [{ mode: "managed", type: "terraform_data", name: "sample", provider: 'provider["terraform.io/builtin/terraform"]', instances: [{ schema_version: 0, attributes: { id: seed.suffix, input: { value, type: "string" }, output: { value, type: "string" }, triggers_replace: null }, sensitive_attributes: [] }] }],
      });
      const create = async (serial: number, raw: string, inline: boolean): Promise<JsonApiResource> => expectSuccessResponse(await request(`/api/v2/workspaces/${workspaceId}/state-versions`, {
        method: "POST", headers, body: JSON.stringify({ data: { type: "state-versions", attributes: { serial, lineage: seed.suffix, md5: createHash("md5").update(raw).digest("hex"), ...(inline ? { state: raw } : {}) } } }),
      }), 201, "state-versions");
      const verify = async (resource: JsonApiResource, value: string): Promise<void> => {
        const download = await request(`/api/v2/state-versions/${resource.id}/download`, { headers });
        expect(download.status).toBe(200);
        const raw = await download.text();
        const row = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, resource.id) });
        expect(JSON.parse(raw)).toMatchObject({ serial: resource.attributes["serial"], lineage: seed.suffix });
        expect(row?.serial).toBe(resource.attributes["serial"] as number);
        expect(resource.attributes["md5"]).toBe(createHash("md5").update(raw).digest("hex"));
        await writeFile(join(directory, "terraform.tfstate"), raw, { mode: 0o600 });
        await writeFile(join(directory, "main.tf"), `resource "terraform_data" "sample" { input = "${value}" }\noutput "sample" { value = terraform_data.sample.output }\noutput "secret" {\n value = "SYNTHETIC_CLI_SECRET"\n sensitive = true\n}\n`);
        const pulled = JSON.parse(await cli("state", "pull"));
        expect(pulled).toMatchObject({ serial: row!.serial, lineage: seed.suffix, outputs: { sample: { value }, secret: { sensitive: true } } });
        const shown = JSON.parse(await cli("show", "-json", "terraform.tfstate"));
        expect(shown.values.root_module.resources[0].address).toBe("terraform_data.sample");
        expect(shown.values.outputs.secret).toMatchObject({ value: "SYNTHETIC_CLI_SECRET", sensitive: true });
        await cli("plan", "-refresh=false", "-lock=false", "-input=false", "-no-color", "-detailed-exitcode");
        const indexed = await request(`/api/v2/state-versions/${resource.id}/outputs`, { headers });
        expect(indexed.status).toBe(200);
        expect((await indexed.json()).data.map((output: JsonApiResource) => output.attributes)).toEqual(expect.arrayContaining([expect.objectContaining({ name: "sample", value }), expect.objectContaining({ name: "secret", sensitive: true })]));
      };
      const original = await create(5, state(5, "original"), true);
      await verify(original, "original");
      const deferred = await create(8, state(8, "newer"), false);
      expect((await request(deferred.attributes["hosted-state-upload-url"] as string, { method: "PUT", body: state(8, "newer") })).status).toBe(200);
      const uploaded = await expectSuccessResponse(await request(`/api/v2/state-versions/${deferred.id}`, { headers }), 200, "state-versions");
      await verify(uploaded, "newer");
      const rolledBack = await expectSuccessResponse(await request(`/api/v2/state-versions/${original.id}/actions/rollback`, { method: "POST", headers }), 201, "state-versions");
      expect(rolledBack.attributes["serial"]).toBe(9);
      await verify(rolledBack, "original");
      const capture = join(storageDir, "recovery", runId);
      await mkdir(capture, { recursive: true });
      await writeFile(join(capture, "terraform.tfstate"), state(5, "recovered"));
      await writeFile(join(capture, ".recovered"), "complete");
      const recovered = await expectSuccessResponse(await request(`/api/v2/runs/${runId}/actions/recover-state`, { method: "POST", headers }), 201, "state-versions");
      expect(recovered.attributes["serial"]).toBe(10);
      await verify(recovered, "recovered");
      const stale = await request(`/api/v2/workspaces/${workspaceId}/state-versions`, { method: "POST", headers, body: JSON.stringify({ data: { type: "state-versions", attributes: { serial: 8, state: state(8, "stale"), md5: createHash("md5").update(state(8, "stale")).digest("hex") } } }) });
      expect(stale.status).toBe(409);
      const current = await expectSuccessResponse(await request(`/api/v2/workspaces/${workspaceId}/current-state-version`, { headers }), 200, "state-versions");
      expect(current.id).toBe(recovered.id);
      await verify(current, "recovered");
    }, 180_000);
  });
}
