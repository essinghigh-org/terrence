import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { ensureBinary } from "../../src/binaryManager";
import { db } from "../../src/db";
import { storageDir } from "../../src/db/driver";
import { runs, stateVersions, workspaces } from "../../src/db/schema";
import {
  cleanupSeed,
  expectSuccessResponse,
  jsonHeaders,
  persistSeed,
  request,
  seedOrg,
  type JsonApiResource,
} from "./compat_contract_helpers";

// Issue #694 (COMP-05): exercise the deferred-upload lifecycle through
// genuine Terraform/OpenTofu workflows. Where the existing
// state_cli_integrity suite pushes hand-built fixtures and reads them back
// with the CLI, every byte here is produced by a real engine apply: the
// workspace lineage is engine-assigned, serials advance through real
// applies, and a second working directory plays the stale second writer. A
// live loopback listener carries the crash-injection upload that
// in-process request handling cannot simulate: a PUT whose body dies
// mid-stream must never become current state.
const CONFIG = (input: string): string => `resource "terraform_data" "sample" {
  input = "${input}"
}

output "sample" {
  value = terraform_data.sample.output
}

output "secret" {
  value     = "SYNTHETIC_CLI_SECRET"
  sensitive = true
}
`;

// One live listener for the whole file: only the crash-injection test needs
// real sockets, everything else uses in-process requests.
let liveBase = "";
beforeAll(async () => {
  void app.listen({ port: 0, hostname: "127.0.0.1" });
  const port = app.server?.port;
  if (typeof port !== "number") throw new Error("live test listener did not bind");
  liveBase = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const res = await fetch(`${liveBase}/healthz`);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("live test listener did not become ready");
}, 30_000);

afterAll(async () => {
  await app.server?.stop();
});

for (const engine of ["terraform", "tofu"] as const) {
  describe(`${engine} CLI-produced state lifecycle`, () => {
    const seed = seedOrg(`cli-lifecycle-${engine}`);
    const workspaceId = `workspace-${seed.suffix}`;
    const runId = `run-${seed.suffix}`;
    const headers = jsonHeaders(seed.token);
    let directory = "";
    let rivalDirectory = "";
    let binary = "";
    let lineage = "";
    let input = "";

    const cliEnv = (cwd: string): Record<string, string> => ({
      PATH: process.env["PATH"] ?? "",
      HOME: cwd,
      TF_IN_AUTOMATION: "1",
      CHECKPOINT_DISABLE: "1",
    });
    const runCli = async (cwd: string, ...args: string[]): Promise<string> => {
      const child = Bun.spawn([binary, ...args], {
        cwd,
        env: cliEnv(cwd),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      return stdout;
    };
    const apply = async (cwd: string, value: string): Promise<{ raw: string; serial: number; stateLineage: string }> => {
      await writeFile(join(cwd, "main.tf"), CONFIG(value));
      await runCli(cwd, "init", "-input=false", "-no-color");
      // -refresh=false keeps the serial advance to exactly one per apply: a
      // default apply persists once for refresh and once for the new state.
      await runCli(cwd, "apply", "-auto-approve", "-input=false", "-no-color", "-lock=false", "-refresh=false");
      const raw = await readFile(join(cwd, "terraform.tfstate"), "utf8");
      const parsed = JSON.parse(raw) as { serial: number; lineage: string };
      return { raw, serial: parsed.serial, stateLineage: parsed.lineage };
    };
    const reserve = (serial: number, extra: Record<string, unknown> = {}): Promise<Response> =>
      request(`/api/v2/workspaces/${workspaceId}/state-versions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ data: { type: "state-versions", attributes: { serial, ...extra } } }),
      });
    const put = (id: string, body: string): Promise<Response> =>
      request(`/api/v2/state-versions/${id}/upload`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body,
      });
    const latestSerial = async (): Promise<number> => {
      const body = (await (await request(`/api/v2/workspaces/${workspaceId}/state-versions`, { headers })).json()) as { data: JsonApiResource[] };
      return Math.max(...body.data.map((entry) => entry.attributes["serial"] as number));
    };

    beforeAll(async () => {
      binary = Bun.which(engine) ?? (await ensureBinary(engine))?.binaryPath ?? "";
      if (binary === "") throw new Error(`Could not obtain ${engine}`);
      directory = await mkdtemp(join(tmpdir(), `terrence-cli-life-${engine}-`));
      rivalDirectory = await mkdtemp(join(tmpdir(), `terrence-cli-rival-${engine}-`));
      await persistSeed(seed);
      await db.insert(workspaces).values({ id: workspaceId, name: `cli-lifecycle-${engine}`, orgId: seed.orgId });
      await db.insert(runs).values({ id: runId, workspaceId, status: "planned", createdAt: Date.now() });
      expect((await request(`/api/v2/workspaces/${workspaceId}/actions/lock`, { method: "POST", headers })).status).toBe(200);
    }, 180_000);

    afterAll(async () => {
      if (directory !== "") await rm(directory, { recursive: true, force: true });
      if (rivalDirectory !== "") await rm(rivalDirectory, { recursive: true, force: true });
      await rm(join(storageDir, "recovery", runId), { recursive: true, force: true });
      await db.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
      await db.delete(runs).where(eq(runs.id, runId));
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await cleanupSeed(seed);
    });

    it("pushes engine-applied bytes through a deferred reservation with matching digest, serial and lineage", async () => {
      input = "cli-lifecycle";
      const first = await apply(directory, input);
      lineage = first.stateLineage;
      expect(lineage).not.toBe("");
      const reserved = await expectSuccessResponse(await reserve(first.serial), 201, "state-versions");
      expect((await put(reserved.id, first.raw)).status).toBe(200);
      const downloaded = await (await request(`/api/v2/state-versions/${reserved.id}/download`, { headers })).text();
      expect(downloaded).toBe(first.raw);
      expect(JSON.parse(downloaded)).toMatchObject({ serial: first.serial, lineage });
      const row = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, reserved.id) });
      expect(row?.serial).toBe(first.serial);
      expect(row?.uploadSha256).toBe(createHash("sha256").update(first.raw).digest("hex"));
      const shown = JSON.parse(await runCli(directory, "show", "-json", "terraform.tfstate"));
      expect(shown.values.root_module.resources[0].address).toBe("terraform_data.sample");
      expect(shown.values.outputs.secret).toMatchObject({ value: "SYNTHETIC_CLI_SECRET", sensitive: true });
      const indexed = await request(`/api/v2/state-versions/${reserved.id}/outputs`, { headers });
      expect(((await indexed.json()) as { data: JsonApiResource[] }).data.map((output) => output.attributes)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "sample", value: input }),
          expect.objectContaining({ name: "secret", sensitive: true }),
        ]),
      );
    }, 240_000);

    it("rejects a genuine second-writer lineage without moving current state", async () => {
      const rivalDir = rivalDirectory;
      await writeFile(join(rivalDir, "main.tf"), CONFIG("cli-rival"));
      await runCli(rivalDir, "init", "-input=false", "-no-color");
      await runCli(rivalDir, "apply", "-auto-approve", "-input=false", "-no-color", "-lock=false", "-refresh=false");
      await writeFile(join(rivalDir, "main.tf"), CONFIG("cli-rival-v2"));
      await runCli(rivalDir, "apply", "-auto-approve", "-input=false", "-no-color", "-lock=false", "-refresh=false");
      const rivalRaw = await readFile(join(rivalDir, "terraform.tfstate"), "utf8");
      const rival = JSON.parse(rivalRaw) as { serial: number; lineage: string };
      expect(rival.lineage).not.toBe(lineage);
      const current = await expectSuccessResponse(
        await request(`/api/v2/workspaces/${workspaceId}/current-state-version`, { headers }), 200, "state-versions",
      );
      expect(rival.serial).toBeGreaterThan(current.attributes["serial"] as number);
      // The reservation records the declared lineage; the stale bytes are
      // rejected when they arrive, and current state never moves. Discarding
      // the spent reservation frees the serial for the legitimate writer.
      const reservation = await expectSuccessResponse(
        await reserve(rival.serial, { lineage: rival.lineage }), 201, "state-versions",
      );
      expect((await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, reservation.id) }))?.expectedLineage).toBe(rival.lineage);
      expect((await put(reservation.id, rivalRaw)).status).toBe(422);
      expect((await request(`/api/v2/state-versions/${reservation.id}`, { method: "DELETE", headers })).status).toBe(204);
      const stillCurrent = await expectSuccessResponse(
        await request(`/api/v2/workspaces/${workspaceId}/current-state-version`, { headers }), 200, "state-versions",
      );
      expect(stillCurrent.id).toBe(current.id);
      expect(await (await request(`/api/v2/state-versions/${current.id}/download`, { headers })).text()).toBe(
        await readFile(join(directory, "terraform.tfstate"), "utf8"),
      );
    }, 240_000);

    it("advances through a second engine apply and proves the round trip plans clean", async () => {
      input = "cli-lifecycle-v2";
      const second = await apply(directory, input);
      expect(second.stateLineage).toBe(lineage);
      // Replacement applies persist twice (one serial per graph commit),
      // so only advancement — never the exact increment — is asserted.
      expect(second.serial).toBeGreaterThan(await latestSerial());
      const reserved = await expectSuccessResponse(
        await reserve(second.serial, { lineage, md5: createHash("md5").update(second.raw).digest("hex") }), 201, "state-versions",
      );
      expect((await put(reserved.id, second.raw)).status).toBe(200);
      // Tampered bytes against a checksum-bound reservation cannot replace
      // the committed upload, even though serial and lineage still match.
      expect((await put(reserved.id, `${second.raw} `)).status).toBe(409);
      const download = await request(`/api/v2/state-versions/${reserved.id}/download`, { headers });
      await writeFile(join(directory, "terraform.tfstate"), await download.text());
      await runCli(directory, "plan", "-refresh=false", "-lock=false", "-input=false", "-no-color", "-detailed-exitcode");
    }, 240_000);

    it("promotes an intermediate engine upload on unlock and keeps it CLI-readable", async () => {
      const applied = await apply(directory, "cli-lifecycle-intermediate");
      expect(applied.stateLineage).toBe(lineage);
      expect(applied.serial).toBeGreaterThan(await latestSerial());
      const created = await request(`/api/v2/workspaces/${workspaceId}/state-versions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: {
            type: "state-versions",
            attributes: {
              serial: applied.serial,
              intermediate: true,
              state: applied.raw,
              md5: createHash("md5").update(applied.raw).digest("hex"),
            },
          },
        }),
      });
      expect(created.status).toBe(201);
      expect((await request(`/api/v2/workspaces/${workspaceId}/actions/unlock`, { method: "POST", headers })).status).toBe(200);
      const current = await expectSuccessResponse(
        await request(`/api/v2/workspaces/${workspaceId}/current-state-version`, { headers }), 200, "state-versions",
      );
      expect(current.attributes["serial"]).toBe(applied.serial);
      const currentText = await (await request(`/api/v2/state-versions/${current.id}/download`, { headers })).text();
      await writeFile(join(directory, "terraform.tfstate"), currentText);
      expect(JSON.parse(await runCli(directory, "show", "-json", "terraform.tfstate")).values.outputs.sample.value)
        .toBe("cli-lifecycle-intermediate");
      expect((await request(`/api/v2/workspaces/${workspaceId}/actions/lock`, { method: "POST", headers })).status).toBe(200);
    }, 240_000);

    it("survives a crashed upload mid-body: nothing partial becomes current", async () => {
      const applied = await apply(directory, "cli-lifecycle-crash");
      expect(applied.stateLineage).toBe(lineage);
      expect(applied.serial).toBeGreaterThan(await latestSerial());
      const reserved = await expectSuccessResponse(await reserve(applied.serial, { lineage }), 201, "state-versions");
      const priorCurrent = await expectSuccessResponse(
        await request(`/api/v2/workspaces/${workspaceId}/current-state-version`, { headers }), 200, "state-versions",
      );
      const liveHeaders = { ...headers, "Content-Type": "application/json" };
      const encoder = new TextEncoder();
      const dying = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(applied.raw.slice(0, 64)));
          setTimeout(() => {
            controller.error(new Error("simulated client crash"));
          }, 300);
        },
      });
      let status = 0;
      let threw = false;
      try {
        const response = await fetch(`${liveBase}/api/v2/state-versions/${reserved.id}/upload`, {
          method: "PUT",
          headers: liveHeaders,
          body: dying,
          duplex: "half",
        } as RequestInit);
        status = response.status;
        await response.text().catch((): string => {
          return "";
        });
      } catch {
        threw = true;
      }
      expect(threw || status !== 200).toBe(true);
      expect((await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, reserved.id) }))?.status).toBe("pending");
      const currentAfterCrash = await expectSuccessResponse(
        await request(`/api/v2/workspaces/${workspaceId}/current-state-version`, { headers }), 200, "state-versions",
      );
      expect(currentAfterCrash.id).toBe(priorCurrent.id);
      // The crashed PUT releases its server-side upload claim as its handler
      // unwinds, but a client that tore down the socket cannot know cleanup
      // finished; retry boundedly so a transient in-progress 409 resolves.
      let retryStatus = 0;
      for (let attempt = 0; attempt < 5 && retryStatus !== 200; attempt += 1) {
        if (attempt > 0) await Bun.sleep(200);
        const retry = await fetch(`${liveBase}/api/v2/state-versions/${reserved.id}/upload`, {
          method: "PUT",
          headers: liveHeaders,
          body: applied.raw,
        });
        retryStatus = retry.status;
        await retry.text().catch((): string => {
          return "";
        });
      }
      expect(retryStatus).toBe(200);
      const row = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, reserved.id) });
      expect(row?.status).toBe("finalized");
      expect(row?.uploadSha256).toBe(createHash("sha256").update(applied.raw).digest("hex"));
      const current = await expectSuccessResponse(
        await request(`/api/v2/workspaces/${workspaceId}/current-state-version`, { headers }), 200, "state-versions",
      );
      expect(current.id).toBe(reserved.id);
    }, 240_000);

    it("rolls back to engine bytes as a new version and promotes CLI-read recovery", async () => {
      const serial = await latestSerial();
      const body = (await (await request(`/api/v2/workspaces/${workspaceId}/state-versions`, { headers })).json()) as { data: JsonApiResource[] };
      const latest = body.data.find((entry) => entry.attributes["serial"] === serial);
      expect(latest).toBeDefined();
      const rolledBack = await expectSuccessResponse(
        await request(`/api/v2/state-versions/${latest?.id ?? ""}/actions/rollback`, { method: "POST", headers }), 201, "state-versions",
      );
      expect(rolledBack.attributes["serial"]).toBe(serial + 1);
      const rolledText = await (await request(`/api/v2/state-versions/${rolledBack.id}/download`, { headers })).text();
      await writeFile(join(directory, "terraform.tfstate"), rolledText);
      const rolledOutputs = (JSON.parse(rolledText) as { outputs: Record<string, { value: string }> }).outputs;
      expect(JSON.parse(await runCli(directory, "show", "-json", "terraform.tfstate")).values.outputs.sample.value)
        .toBe(rolledOutputs["sample"]?.value);

      const capture = join(storageDir, "recovery", runId);
      await mkdir(capture, { recursive: true });
      await writeFile(join(capture, "terraform.tfstate"), rolledText);
      await writeFile(join(capture, ".recovered"), "complete");
      const recovered = await expectSuccessResponse(
        await request(`/api/v2/runs/${runId}/actions/recover-state`, { method: "POST", headers }), 201, "state-versions",
      );
      expect(recovered.attributes["serial"]).toBe(serial + 2);
      const recoveredText = await (await request(`/api/v2/state-versions/${recovered.id}/download`, { headers })).text();
      await writeFile(join(directory, "terraform.tfstate"), recoveredText);
      expect(JSON.parse(await runCli(directory, "state", "pull"))).toMatchObject({ lineage, serial: serial + 2 });
    }, 240_000);
  });
}
