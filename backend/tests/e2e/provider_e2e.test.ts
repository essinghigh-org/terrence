import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, mkdtempSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const BACKEND_DIR = join(REPO_ROOT, "backend");
const PERSISTENT_STORAGE_DIR = join(BACKEND_DIR, "storage");
const E2E_DIR = join(PERSISTENT_STORAGE_DIR, "provider-e2e");
const TLS_DIR = join(E2E_DIR, "tls");
const CERT_PATH = join(TLS_DIR, "cert.pem");
const KEY_PATH = join(TLS_DIR, "key.pem");

const sleep = (ms: number): Promise<void> => new Promise((resolveFn) => setTimeout(resolveFn, ms));

let terraformBin = "";
let tofuBin = "";

type CliResult = { code: number; out: string; err: string };
type ApiResult = { status: number; json: Record<string, any>; text: string };

const EXPECTED_STATE_ADDRESSES = [
  "tfe_organization.org",
  "tfe_project.proj",
  "tfe_workspace.ws",
  "tfe_workspace.ws2",
  "tfe_variable.var",
  "tfe_variable.var_env",
  "tfe_variable_set.vs",
  "tfe_variable.vs_var",
  "tfe_workspace_variable_set.ws_vs",
  "tfe_project_variable_set.proj_vs",
  "tfe_team.team",
  "tfe_team_token.team_tok",
  "tfe_organization_membership.member",
  "tfe_team_organization_member.team_member",
  "tfe_team_project_access.team_proj_access",
  "tfe_team_access.team_ws_access",
  "tfe_run_trigger.trigger",
  "tfe_ssh_key.ssh",
  "tfe_workspace_settings.ws_settings",
];

function freePort(): Promise<number> {
  return new Promise((resolveFn, rejectFn) => {
    const srv = createServer();
    srv.once("error", rejectFn);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolveFn(port));
    });
  });
}

async function ensureCert(): Promise<void> {
  if (existsSync(CERT_PATH) && existsSync(KEY_PATH)) return;
  await mkdir(TLS_DIR, { recursive: true });
  const proc = Bun.spawn([
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    "-keyout", KEY_PATH, "-out", CERT_PATH,
  ]);
  if ((await proc.exited) !== 0) throw new Error("openssl certificate generation failed");
}

type Backend = { port: number; proc: Bun.Subprocess; dbDir: string; logPath: string };

async function startBackend(workDir: string): Promise<Backend> {
  const dbDir = mkdtempSync(join(tmpdir(), "terrence-provider-e2e-"));
  const port = await freePort();
  const logPath = join(workDir, "server.log");
  const proc = Bun.spawn(["bun", "run", "index.ts"], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      TERRENCE_DATABASE_PATH: join(workDir, "test.db"),
      TERRENCE_JWT_SECRET: "provider-e2e-secret",
      TERRENCE_RUN_SANDBOX: "false",
      TERRENCE_ENABLE_LOCAL_SIGNUP: "true",
    },
    stdout: openSync(logPath, "w"),
    stderr: openSync(logPath, "w"),
  });
  for (let i = 0; i < 300; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return { port, proc, dbDir, logPath };
    } catch {}
    if (proc.exitCode !== null) break;
    await sleep(200);
  }
  const tail = (await readFile(logPath, "utf8").catch(() => "")).split("\n").slice(-60).join("\n");
  throw new Error(`backend failed to start within 60s\n${tail}`);
}

async function startTlsProxy(backendPort: number): Promise<Awaited<ReturnType<typeof Bun.serve>>> {
  const cert = await Bun.file(CERT_PATH).arrayBuffer();
  const key = await Bun.file(KEY_PATH).arrayBuffer();
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    fetch: (req): Promise<Response> => {
      const url = new URL(req.url);
      url.protocol = "http:";
      url.host = `127.0.0.1:${backendPort}`;
      return fetch(new Request(url, req));
    },
  });
}

async function api(port: number, method: string, path: string, body?: unknown, token?: string): Promise<ApiResult> {
  const init: RequestInit = { method, headers: {} };
  const headers = init.headers as Record<string, string>;
  if (body !== undefined) {
    headers["Content-Type"] = "application/vnd.api+json";
    init.body = JSON.stringify(body);
  }
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

async function signupAndToken(port: number): Promise<{ token: string; userId: string; username: string }> {
  const username = `pe2e-${Date.now().toString(36)}`;
  const password = "pe2e-password-123";
  await api(port, "POST", "/api/v2/users", {
    data: { type: "users", attributes: { username, password } },
  });
  const login = await api(port, "POST", "/api/v2/users/login", {
    data: { attributes: { username, password } },
  });
  expect(login.status).toBe(200);
  const token = login.json.data.attributes.token as string;
  expect(typeof token).toBe("string");
  expect(token).not.toBe("");
  const details = await api(port, "GET", "/api/v2/account/details", undefined, token);
  expect(details.status).toBe(200);
  const userId = details.json.data.id as string;
  expect(userId).not.toBe("");
  return { token, userId, username };
}

async function cli(bin: string, args: string[], cwd: string, env: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn([bin, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  return { code, out, err };
}

function cliOk(result: CliResult, what: string): void {
  if (result.code !== 0) {
    throw new Error(`${what} failed (exit ${result.code}):\n--- stdout ---\n${result.out}\n--- stderr ---\n${result.err}`);
  }
}

function providerTf(proxyPort: number, token: string): string {
  return `terraform {
  required_providers {
    tfe = { source = "hashicorp/tfe" }
  }
}

provider "tfe" {
  hostname        = "127.0.0.1:${proxyPort}"
  token           = "${token}"
  ssl_skip_verify = true
}
`;
}

function mainTf(suffix: string, username: string): string {
  const org = `pe2e-org-${suffix}`;
  return `resource "tfe_organization" "org" {
  name  = "${org}"
  email = "pe2e@example.com"
}

resource "tfe_project" "proj" {
  organization = tfe_organization.org.name
  name         = "pe2e-proj-${suffix}"
}

resource "tfe_workspace" "ws" {
  organization = tfe_organization.org.name
  name         = "pe2e-ws-${suffix}"
  project_id   = tfe_project.proj.id
  auto_apply   = true
  force_delete = true
}

resource "tfe_workspace" "ws2" {
  organization = tfe_organization.org.name
  name         = "pe2e-ws2-${suffix}"
  project_id   = tfe_project.proj.id
  force_delete = true
}

resource "tfe_variable" "var" {
  workspace_id = tfe_workspace.ws.id
  key          = "pe2e_key"
  value        = "pe2e_value"
  category     = "terraform"
  sensitive    = false
}

resource "tfe_variable" "var_env" {
  workspace_id = tfe_workspace.ws.id
  key          = "PE2E_ENV"
  value        = "pe2e-env-value"
  category     = "env"
  sensitive    = true
}

resource "tfe_variable_set" "vs" {
  organization = tfe_organization.org.name
  name         = "pe2e-vs-${suffix}"
  description  = "provider e2e variable set"
  global       = false
}

resource "tfe_variable" "vs_var" {
  variable_set_id = tfe_variable_set.vs.id
  key             = "pe2e_vs_key"
  value           = "pe2e_vs_value"
  category        = "terraform"
}

resource "tfe_workspace_variable_set" "ws_vs" {
  workspace_id    = tfe_workspace.ws.id
  variable_set_id = tfe_variable_set.vs.id
}

resource "tfe_project_variable_set" "proj_vs" {
  project_id      = tfe_project.proj.id
  variable_set_id = tfe_variable_set.vs.id
}

resource "tfe_team" "team" {
  organization = tfe_organization.org.name
  name         = "pe2e-team-${suffix}"
}

resource "tfe_team_token" "team_tok" {
  team_id = tfe_team.team.id
}

resource "tfe_organization_membership" "member" {
  organization = tfe_organization.org.name
  email        = "pe2e+${suffix}@example.com"
}

resource "tfe_team_organization_member" "team_member" {
  team_id                    = tfe_team.team.id
  organization_membership_id = tfe_organization_membership.member.id
}

resource "tfe_team_member" "member_user" {
  team_id  = tfe_team.team.id
  username = "${username}"
}

resource "tfe_team_project_access" "team_proj_access" {
  team_id    = tfe_team.team.id
  project_id = tfe_project.proj.id
  access     = "write"
}

resource "tfe_team_access" "team_ws_access" {
  team_id      = tfe_team.team.id
  workspace_id = tfe_workspace.ws.id
  access       = "plan"
}

resource "tfe_run_trigger" "trigger" {
  workspace_id  = tfe_workspace.ws.id
  sourceable_id = tfe_workspace.ws2.id
}

resource "tfe_ssh_key" "ssh" {
  organization = tfe_organization.org.name
  name         = "pe2e-ssh-${suffix}"
  key          = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC${suffix} e2e@terrence"
}

resource "tfe_workspace_settings" "ws_settings" {
  workspace_id        = tfe_workspace.ws.id
  global_remote_state = true
}
`;
}

async function planAndApply(port: number, token: string, orgName: string, wsName: string, workDir: string): Promise<void> {
  const list = await api(port, "GET", `/api/v2/organizations/${orgName}/workspaces`, undefined, token);
  expect(list.status).toBe(200);
  const ws = list.json.data.find((w: any): boolean => w.attributes.name === wsName);
  expect(ws).toBeDefined();
  const wsId = ws.id as string;

  const cv = await api(port, "POST", `/api/v2/workspaces/${wsId}/configuration-versions`, {
    data: { type: "configuration-versions", attributes: { "auto-queue-runs": true } },
  }, token);
  expect(cv.status).toBe(201);
  const cvId = cv.json.data.id as string;

  const cfgDir = join(workDir, "run-config");
  await mkdir(cfgDir, { recursive: true });
  await writeFile(join(cfgDir, "main.tf"), `terraform {
  required_providers {
    null = { source = "hashicorp/null", version = "~> 3.2" }
  }
}

resource "null_resource" "probe" {
  provisioner "local-exec" {
    command = "echo PROVIDER_E2E_OK && uname -a"
  }
}
`);
  const tarProc = Bun.spawn(["tar", "-czf", join(workDir, "config.tar.gz"), "-C", cfgDir, "."]);
  if ((await tarProc.exited) !== 0) throw new Error("tar failed");

  const upload = await fetch(`http://127.0.0.1:${port}/api/v2/configuration-versions/${cvId}/upload`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization: `Bearer ${token}`,
    },
    body: await Bun.file(join(workDir, "config.tar.gz")).arrayBuffer(),
  });
  expect(upload.status).toBe(200);

  const run = await api(port, "POST", "/api/v2/runs", {
    data: {
      type: "runs",
      attributes: { "auto-apply": true, message: "provider e2e apply" },
      relationships: {
        workspace: { data: { type: "workspaces", id: wsId } },
        "configuration-version": { data: { type: "configuration-versions", id: cvId } },
      },
    },
  }, token);
  expect(run.status).toBe(201);
  const runId = run.json.data.id as string;

  let status = "";
  for (let i = 0; i < 240; i++) {
    await sleep(2000);
    const r = await api(port, "GET", `/api/v2/runs/${runId}`, undefined, token);
    status = r.json.data.attributes.status as string;
    if (status === "applied") break;
    if (["errored", "canceled", "discarded", "force_canceled"].includes(status)) {
      const log = await api(port, "GET", `/api/v2/runs/${runId}/plan/log`, undefined, token);
      throw new Error(`run ${runId} ended with status "${status}":\n${log.text}`);
    }
  }
  expect(status, `run ${runId} did not reach applied`).toBe("applied");

  // The state version is created before the run status is set to "applied",
  // but under load there can be a small propagation delay. Retry a few times.
  let sv = await api(port, "GET", `/api/v2/workspaces/${wsId}/current-state-version`, undefined, token);
  for (let i = 0; i < 10 && sv.status !== 200; i++) {
    await sleep(500);
    sv = await api(port, "GET", `/api/v2/workspaces/${wsId}/current-state-version`, undefined, token);
  }
  expect(sv.status).toBe(200);
  const resources = sv.json.data.attributes.resources as Array<{ name: string; type: string }>;
  expect(resources.some((r): boolean => r.name === "probe" && r.type === "null_resource")).toBe(true);

  const apply = await api(port, "GET", `/api/v2/runs/${runId}/apply`, undefined, token);
  const logUrl = apply.json.data.attributes["log-read-url"] as string;
  const logRes = await fetch(logUrl);
  expect(logRes.ok).toBe(true);
  const logText = await logRes.text();
  expect(logText).toContain("Apply complete");
}

describe("tfe provider e2e", () => {
  beforeAll(async () => {
    process.env.STORAGE_DIR = PERSISTENT_STORAGE_DIR;
    const { ensureBinary } = await import("../../src/binaryManager");
    const terraform = await ensureBinary("terraform");
    const tofu = await ensureBinary("tofu");
    if (terraform === null || tofu === null) throw new Error("could not obtain terraform and tofu binaries (network required)");
    terraformBin = terraform.binaryPath;
    tofuBin = tofu.binaryPath;
    await ensureCert();
  }, 300_000);

  for (const cliName of ["terraform", "tofu"] as const) {
    test(`latest hashicorp/tfe provider: full lifecycle against Terrence via ${cliName} CLI`, async () => {
      const bin = cliName === "terraform" ? terraformBin : tofuBin;
      const suffix = `${cliName}${Date.now().toString(36)}`;
      const workDir = join(E2E_DIR, suffix);
      await mkdir(workDir, { recursive: true });
      const cliEnv: Record<string, string> = {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        TF_IN_AUTOMATION: "1",
      };

      const backend = await startBackend(workDir);
      try {
        const proxy = await startTlsProxy(backend.port);
        try {
          const auth = await signupAndToken(backend.port);

          const cfgDir = join(workDir, "config");
          await mkdir(cfgDir, { recursive: true });
          await writeFile(join(cfgDir, "providers.tf"), providerTf(proxy.port as number, auth.token));
          await writeFile(join(cfgDir, "main.tf"), mainTf(suffix, auth.username));

          cliOk(await cli(bin, ["init", "-input=false", "-no-color"], cfgDir, cliEnv), "init");
          cliOk(await cli(bin, ["plan", "-input=false", "-no-color"], cfgDir, cliEnv), "plan");
          const apply = await cli(bin, ["apply", "-auto-approve", "-input=false", "-no-color"], cfgDir, cliEnv);
          cliOk(apply, "apply");
          expect(apply.out).toContain("Apply complete");

          const stateList = await cli(bin, ["state", "list"], cfgDir, cliEnv);
          cliOk(stateList, "state list");
          for (const addr of EXPECTED_STATE_ADDRESSES) {
            expect(stateList.out, `missing ${addr} in state`).toContain(addr);
          }

          await planAndApply(backend.port, auth.token, `pe2e-org-${suffix}`, `pe2e-ws-${suffix}`, workDir);

          const destroy = await cli(bin, ["destroy", "-auto-approve", "-input=false", "-no-color"], cfgDir, cliEnv);
          cliOk(destroy, "destroy");
          expect(destroy.out).toContain("Destroy complete");
        } finally {
          proxy.stop(true);
        }
      } finally {
        backend.proc.kill();
      }
    }, 900_000);
  }
});
