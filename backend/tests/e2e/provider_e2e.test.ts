import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, openSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const BACKEND_DIR = join(REPO_ROOT, "backend");

const sleep = (ms: number): Promise<void> => new Promise((resolveFn) => setTimeout(resolveFn, ms));

let terraformBin = "";
let tofuBin = "";

// Iteration aid: TERRENCE_E2E_CLI=terraform (or tofu) runs only that CLI;
// unset runs both.
const e2eCliFilter: string | null = process.env.TERRENCE_E2E_CLI ?? null;
if (e2eCliFilter !== null && !["terraform", "tofu"].includes(e2eCliFilter)) {
  throw new Error(`Unsupported TERRENCE_E2E_CLI value: ${e2eCliFilter}`);
}

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
  "tfe_organization_token.org_tok",
  "tfe_audit_trail_token.audit_tok",
  "tfe_team_members.team_members",
  "tfe_team_organization_members.team_org_members",
  "tfe_agent_pool.pool",
  "tfe_agent_token.agent_tok",
  "tfe_oauth_client.client",
  "tfe_policy.policy",
  "tfe_policy_set.ps",
  "tfe_workspace_policy_set.ws_ps",
  "tfe_project_policy_set.project_ps",
  "tfe_organization_run_task.task",
  "tfe_workspace_run_task.ws_task",
  "tfe_notification_configuration.nc",
  "tfe_project_notification_configuration.project_nc",
  "tfe_policy_set_parameter.p_param",
  "tfe_tag_policy_set.tag_inc",
  "tfe_tag_policy_set_exclusion.tag_exc",
  "tfe_project_policy_set_exclusion.proj_ps_excl",
  "tfe_team_notification_configuration.tn",
  "tfe_workspace_policy_set_exclusion.ws_excl",
  "tfe_data_retention_policy.drp",
  "tfe_organization_default_settings.ods",
  "tfe_terraform_version.tfver",
  "tfe_sentinel_version.sentver",
  "tfe_opa_version.opaver",
  "tfe_admin_smtp_settings.smtp",
  "tfe_registry_provider.regprov",
  "tfe_organization_run_task_global_settings.rgs",
  "tfe_project_settings.proj_settings",
  "tfe_provider_set.pset",
  "tfe_agent_pool_allowed_workspaces.apaw",
  "tfe_agent_pool_allowed_projects.apap",
  "tfe_agent_pool_excluded_workspaces.apexw",
  "tfe_org_max_token_ttl_policy.ottl",
  "tfe_registry_module.regmod",
  "tfe_aws_oidc_configuration.aws_oidc",
  "tfe_azure_oidc_configuration.azure_oidc",
  "tfe_gcp_oidc_configuration.gcp_oidc",
  "tfe_vault_oidc_configuration.vault_oidc",
  "tfe_hyok_configuration.hyok",
  "tfe_saml_settings.saml",
  "tfe_scim_settings.scim",
  "tfe_scim_token.scim_tok",
];

function freePort(): Promise<number> {
  return new Promise((resolveFn, rejectFn) => {
    const srv = createServer();
    srv.once("error", rejectFn);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => { resolveFn(port); });
    });
  });
}

type Backend = { port: number; proc: Bun.Subprocess; dbDir: string; logPath: string; storageDir: string };

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
      DATABASE_URL: `file:${join(dbDir, "test.db")}`,
      STORAGE_DIR: dbDir,
      TERRENCE_JWT_SECRET: "provider-e2e-secret",
      TERRENCE_RUN_SANDBOX: "false",
      TERRENCE_ENABLE_LOCAL_SIGNUP: "true",
      SIMULATED_RUNS: "false",
    },
    stdout: openSync(logPath, "w"),
    stderr: openSync(logPath, "w"),
  });
  for (let i = 0; i < 300; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return { port, proc, dbDir, logPath, storageDir: dbDir };
    } catch {}
    if (proc.exitCode !== null) break;
    await sleep(200);
  }
  const tail = (await readFile(logPath, "utf8").catch(() => "")).split("\n").slice(-60).join("\n");
  throw new Error(`backend failed to start within 60s\n${tail}`);
}

async function startTlsProxy(backendPort: number): Promise<Awaited<ReturnType<typeof Bun.serve>>> {
  const port = await freePort();
  const proc = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", "/tmp/key.pem", "-out", "/tmp/cert.pem"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
  const cert = await Bun.file("/tmp/cert.pem").arrayBuffer();
  const key = await Bun.file("/tmp/key.pem").arrayBuffer();
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    tls: { cert, key },
    fetch: (req): Promise<Response> => {
      const url = new URL(req.url);
      url.protocol = "http";
      url.host = `127.0.0.1:${backendPort}`;
      if (process.env.TERRENCE_E2E_PROXY_LOG === "1") {
        console.log(`[proxy] ${req.method} ${req.url}`);
      }
      return fetch(new Request(url, req)).then((res) => {
        if (process.env.TERRENCE_E2E_PROXY_LOG === "1") {
          console.log(`[proxy] -> ${res.status} ${req.method} ${req.url}`);
        }
        return res;
      }).catch((err: unknown) => {
        console.error(`[proxy] ERROR ${req.method} ${req.url}: ${String(err)}`);
        return new Response("proxy error", { status: 502 });
      });
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

# --- coverage additions beyond the original smoke test ---

resource "tfe_organization_token" "org_tok" {
  organization = tfe_organization.org.name
}

resource "tfe_audit_trail_token" "audit_tok" {
  organization = tfe_organization.org.name
}

resource "tfe_team_members" "team_members" {
  team_id   = tfe_team.team.id
  usernames = ["${username}"]
}

resource "tfe_team_organization_members" "team_org_members" {
  team_id                     = tfe_team.team.id
  organization_membership_ids = [tfe_organization_membership.member.id]
}

resource "tfe_agent_pool" "pool" {
  organization = tfe_organization.org.name
  name         = "pe2e-pool-${suffix}"
}

resource "tfe_agent_token" "agent_tok" {
  agent_pool_id = tfe_agent_pool.pool.id
  description   = "pe2e agent token ${suffix}"
}

resource "tfe_oauth_client" "client" {
  organization     = tfe_organization.org.name
  name             = "pe2e-oauth-${suffix}"
  api_url          = "https://api.github.com"
  http_url         = "https://github.com"
  oauth_token      = "ghp_pe2e_${suffix}"
  service_provider = "github"
}

resource "tfe_policy" "policy" {
  organization = tfe_organization.org.name
  name         = "pe2e-policy-${suffix}"
  kind         = "sentinel"
  enforce_mode = "advisory"
  policy       = "main = rule { true }"
}

resource "tfe_policy_set" "ps" {
  organization = tfe_organization.org.name
  name         = "pe2e-ps-${suffix}"
  policy_ids   = [tfe_policy.policy.id]
}

resource "tfe_workspace_policy_set" "ws_ps" {
  policy_set_id = tfe_policy_set.ps.id
  workspace_id  = tfe_workspace.ws.id
}

resource "tfe_project_policy_set" "project_ps" {
  policy_set_id = tfe_policy_set.ps.id
  project_id    = tfe_project.proj.id
}

resource "tfe_organization_run_task" "task" {
  organization = tfe_organization.org.name
  name         = "pe2e-task-${suffix}"
  url          = "https://pe2e.example.com/task"
  category     = "task"
}

resource "tfe_workspace_run_task" "ws_task" {
  workspace_id      = tfe_workspace.ws.id
  task_id           = tfe_organization_run_task.task.id
  enforcement_level = "advisory"
  stages            = ["pre_plan"]
}

resource "tfe_notification_configuration" "nc" {
  workspace_id     = tfe_workspace.ws.id
  name             = "pe2e-nc-${suffix}"
  url              = "https://pe2e.example.com/nc"
  destination_type = "generic"
  triggers         = ["run:completed"]
  token            = "pe2e-nc-token"
}

resource "tfe_project_notification_configuration" "project_nc" {
  project_id       = tfe_project.proj.id
  name             = "pe2e-prj-nc-${suffix}"
  url              = "https://pe2e.example.com/nc"
  destination_type = "generic"
  triggers         = ["run:completed"]
  token            = "pe2e-nc-token"
}

# --- coverage batch 2: org/platform resources with backend support ---

resource "tfe_policy_set_parameter" "p_param" {
  key           = "pe2e_param"
  value         = "pe2e_param_value"
  policy_set_id = tfe_policy_set.ps.id
}

resource "tfe_tag_policy_set" "tag_inc" {
  policy_set_id = tfe_policy_set.ps.id
  key           = "pe2e-tag-inc-${suffix}"
  value         = "pe2e-value"
}

resource "tfe_tag_policy_set_exclusion" "tag_exc" {
  policy_set_id = tfe_policy_set.ps.id
  key           = "pe2e-tag-exc-${suffix}"
}

resource "tfe_project_policy_set_exclusion" "proj_ps_excl" {
  policy_set_id = tfe_policy_set.ps.id
  project_id    = tfe_project.proj.id
}

resource "tfe_team_notification_configuration" "tn" {
  team_id          = tfe_team.team.id
  name             = "pe2e-team-nc-${suffix}"
  destination_type = "generic"
  url              = "https://pe2e.example.com/team-nc"
  triggers         = ["change_request:created"]
}

resource "tfe_workspace_policy_set_exclusion" "ws_excl" {
  policy_set_id = tfe_policy_set.ps.id
  workspace_id  = tfe_workspace.ws2.id
}

resource "tfe_data_retention_policy" "drp" {
  organization = tfe_organization.org.name
  delete_older_than {
    days = 30
  }
}

resource "tfe_organization_default_settings" "ods" {
  organization           = tfe_organization.org.name
  default_execution_mode = "remote"
}

# --- coverage batch 3: admin/version/platform resources (site-admin token) ---

resource "tfe_terraform_version" "tfver" {
  version = "1.15.8-pe2e-${suffix}"
  url     = "https://releases.hashicorp.com/terraform/1.15.8/terraform_1.15.8_linux_amd64.zip"
  sha     = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2"
  beta    = false
}

resource "tfe_sentinel_version" "sentver" {
  version = "0.41.0-pe2e-${suffix}"
  url     = "https://releases.hashicorp.com/sentinel/0.41.0/sentinel_0.41.0_linux_amd64.zip"
  sha     = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c"
}

resource "tfe_opa_version" "opaver" {
  version = "0.60.0-pe2e-${suffix}"
  url     = "https://github.com/open-policy-agent/opa/releases/download/v0.60.0/opa_linux_amd64_static"
  sha     = "c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e"
}

resource "tfe_admin_smtp_settings" "smtp" {
  enabled  = true
  host     = "smtp.pe2e.example.com"
  port     = 587
  username = "pe2e-smtp-user"
  password = "pe2e-smtp-password"
  sender   = "pe2e@example.com"
  auth     = "login"
}

# --- coverage batch 4: private registry ---

resource "tfe_registry_provider" "regprov" {
  name          = "pe2e-prov-${suffix}"
  organization  = tfe_organization.org.name
  registry_name = "private"
}

resource "tfe_organization_run_task_global_settings" "rgs" {
  task_id           = tfe_organization_run_task.task.id
  enforcement_level = "advisory"
  stages            = ["pre_plan", "post_plan"]
}

resource "tfe_project_settings" "proj_settings" {
  project_id             = tfe_project.proj.id
  default_execution_mode = "remote"
}

resource "tfe_provider_set" "pset" {
  name            = "pe2e-pset-${suffix}"
  organization    = tfe_organization.org.name
  provider_source = "registry.terraform.io/hashicorp/aws"
  global          = true
  provider_config_hcl = <<-EOT
  version = "~> 5.0"
EOT
}

resource "tfe_agent_pool_allowed_workspaces" "apaw" {
  agent_pool_id        = tfe_agent_pool.pool.id
  allowed_workspace_ids = [tfe_workspace.ws.id]
}

resource "tfe_agent_pool_allowed_projects" "apap" {
  agent_pool_id     = tfe_agent_pool.pool.id
  allowed_project_ids = [tfe_project.proj.id]
}

resource "tfe_agent_pool_excluded_workspaces" "apexw" {
  agent_pool_id          = tfe_agent_pool.pool.id
  excluded_workspace_ids = [tfe_workspace.ws2.id]
}

resource "tfe_org_max_token_ttl_policy" "ottl" {
  organization             = tfe_organization.org.name
  org_token_max_ttl        = "1d"
  team_token_max_ttl       = "2d"
  user_token_max_ttl       = "1w"
  audit_trail_token_max_ttl = "2w"
}

resource "tfe_registry_module" "regmod" {
  name            = "pe2e-mod-${suffix}"
  organization    = tfe_organization.org.name
  registry_name   = "private"
  module_provider = "aws"
}

resource "tfe_aws_oidc_configuration" "aws_oidc" {
  organization = tfe_organization.org.name
  role_arn     = "arn:aws:iam::123456789012:role/pe2e-oidc-role"
}

resource "tfe_azure_oidc_configuration" "azure_oidc" {
  organization    = tfe_organization.org.name
  client_id       = "00000000-0000-0000-0000-000000000001"
  subscription_id = "00000000-0000-0000-0000-000000000002"
  tenant_id       = "00000000-0000-0000-0000-000000000003"
}

resource "tfe_gcp_oidc_configuration" "gcp_oidc" {
  organization            = tfe_organization.org.name
  project_number          = "123456789012"
  service_account_email   = "pe2e-sa@gcp-project.iam.gserviceaccount.com"
  workload_provider_name  = "projects/123456789012/locations/global/workloadIdentityPools/pool/providers/provider"
}

resource "tfe_vault_oidc_configuration" "vault_oidc" {
  organization = tfe_organization.org.name
  address      = "https://vault.example.com"
  namespace    = "admin"
  role_name    = "pe2e-role"
}

resource "tfe_hyok_configuration" "hyok" {
  organization            = tfe_organization.org.name
  name                    = "pe2e-hyok-${suffix}"
  kek_id                  = "arn:aws:kms:us-east-1:123456789012:key/pe2e-kek"
  agent_pool_id           = tfe_agent_pool.pool.id
  oidc_configuration_id   = tfe_vault_oidc_configuration.vault_oidc.id
  oidc_configuration_type = "vault"
}

resource "tfe_saml_settings" "saml" {
  idp_cert = <<-EOT
-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUEJYth31uZD/ISbnf2jBNHHs5QTswDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJcGUyZS1zYW1sMB4XDTI2MDgwNjA4MTE0NFoXDTM2MDgw
MzA4MTE0NFowFDESMBAGA1UEAwwJcGUyZS1zYW1sMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAnMuEDDS/IpVp1SIK7EMkUPf1Vm1Eehzbah3RuWG5aKDx
tILt9u5LYCI/uYwmMcqLmeAx+tUzpzzSNobYsXGIK1CMaFIM8gfdWfGwV/V3Ls8E
4yvxA/7/gH0o0QN3TfudGd7MAIJE2OPqWggyfWD2IatKbjREjbHNkuzvUKMv5LJ4
GaxVOBK3jjNw7z+k8TwNsYzRJB1m+q2MX5hR5ZF1m41PXIWKmcsoeW1c43l0pvXF
0/GY2QHyMDucBJpXdH8HfLHIa6CgMgS3yEODyM1On+779Gz23NlAJqxZCBemnDZ7
2LO3azAStOi9gRyBpmbh7kf1yHzcBK3IS4cRWxCPowIDAQABo1MwUTAdBgNVHQ4E
FgQUeDxXMacJKKGyJ4UdMAytce/ZXoQwHwYDVR0jBBgwFoAUeDxXMacJKKGyJ4Ud
MAytce/ZXoQwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAJzV2
fMNpnPDeH0QM42LFRseN3djaBNVKkQ3qHhha6s8vUBCGHjbyMkaoCOnP+7BgK0ka
WeSqPnOsbslao5Egf1hAc+SGDXYQKv1mlXS1869RpWnMsxS+aX85E4l9y73GcTNj
aKe/LSjSp3gyho06nIX/YS5eYc8KQTaQZU53gVf1fs9/tamCfHwGR0ejxYsCwmZy
4uiTnJq/mJGqIkROozLuvsxtXRePIawTRqwmkyJLFrPNdY0Kal6ieQwfq89Rn5VY
OGMnxsBKUikIADzpC0yRNRNj59RVPprxNespSBF7l96neB5dcgFMAX/MMIAcYHYr
etdW1cufqHhJK0JwAA==
-----END CERTIFICATE-----
EOT
  slo_endpoint_url = "https://saml.pe2e.example.com/slo"
  sso_endpoint_url = "https://saml.pe2e.example.com/sso"
}

resource "tfe_scim_settings" "scim" {
  depends_on = [tfe_saml_settings.saml]
}

resource "tfe_scim_token" "scim_tok" {
  description = "pe2e-scim-token-${suffix}"
  depends_on  = [tfe_scim_settings.scim]
}
`;
}

// Every data source the tfe provider exposes whose backing object the main
// config creates (i.e. every data source Terrence can serve). Each depends_on
// the resource(s) it reads, so Terraform defers the read until AFTER that
// resource is created in apply (a data source referencing a same-apply
// resource is otherwise read at plan time, before anything exists).
function outputsTf(): string {
  return `data "tfe_organizations" "d_orgs" {
  depends_on = [tfe_organization.org]
}
data "tfe_organization" "d_org" {
  name       = tfe_organization.org.name
  depends_on = [tfe_organization.org]
}
data "tfe_workspace" "d_ws" {
  name         = tfe_workspace.ws.name
  organization = tfe_organization.org.name
  depends_on   = [tfe_workspace.ws]
}
data "tfe_workspace" "d_ws2" {
  name         = tfe_workspace.ws2.name
  organization = tfe_organization.org.name
  depends_on   = [tfe_workspace.ws2]
}
data "tfe_workspace_ids" "d_wsids" {
  organization = tfe_organization.org.name
  names        = [tfe_workspace.ws.name, tfe_workspace.ws2.name]
  depends_on   = [tfe_organization.org, tfe_workspace.ws, tfe_workspace.ws2]
}
data "tfe_project" "d_proj" {
  name         = tfe_project.proj.name
  organization = tfe_organization.org.name
  depends_on   = [tfe_project.proj]
}
data "tfe_projects" "d_projs" {
  organization = tfe_organization.org.name
  depends_on   = [tfe_organization.org, tfe_project.proj]
}
data "tfe_team" "d_team" {
  name         = tfe_team.team.name
  organization = tfe_organization.org.name
  depends_on   = [tfe_team.team]
}
data "tfe_teams" "d_teams" {
  organization = tfe_organization.org.name
  depends_on   = [tfe_organization.org, tfe_team.team]
}
data "tfe_variable_set" "d_vs" {
  name         = tfe_variable_set.vs.name
  organization = tfe_organization.org.name
  depends_on   = [tfe_variable_set.vs]
}
data "tfe_variables" "d_vars_vs" {
  variable_set_id = tfe_variable_set.vs.id
  depends_on      = [tfe_variable_set.vs, tfe_variable.vs_var]
}
data "tfe_variables" "d_vars_ws" {
  workspace_id = tfe_workspace.ws.id
  depends_on   = [tfe_workspace.ws, tfe_variable.var, tfe_variable.var_env]
}
data "tfe_ssh_key" "d_ssh" {
  name         = tfe_ssh_key.ssh.name
  organization = tfe_organization.org.name
  depends_on   = [tfe_ssh_key.ssh]
}
data "tfe_organization_membership" "d_member" {
  organization = tfe_organization.org.name
  email        = tfe_organization_membership.member.email
  depends_on   = [tfe_organization_membership.member]
}
data "tfe_organization_members" "d_members" {
  organization = tfe_organization.org.name
  depends_on   = [tfe_organization.org]
}
data "tfe_team_access" "d_access" {
  team_id      = tfe_team.team.id
  workspace_id = tfe_workspace.ws.id
  depends_on   = [tfe_team_access.team_ws_access]
}
data "tfe_team_project_access" "d_proj_access" {
  team_id    = tfe_team.team.id
  project_id = tfe_project.proj.id
  depends_on = [tfe_team_project_access.team_proj_access]
}
data "tfe_policy_set" "d_ps" {
  name         = tfe_policy_set.ps.name
  organization = tfe_organization.org.name
  depends_on   = [tfe_policy_set.ps]
}
data "tfe_oauth_client" "d_oc" {
  organization     = tfe_organization.org.name
  name             = tfe_oauth_client.client.name
  service_provider = "github"
  depends_on       = [tfe_oauth_client.client]
}
data "tfe_agent_pool" "d_pool" {
  name         = tfe_agent_pool.pool.name
  organization = tfe_organization.org.name
  depends_on   = [tfe_agent_pool.pool]
}
data "tfe_current_user" "d_me" {}
data "tfe_organization_run_task" "d_task" {
  name         = tfe_organization_run_task.task.name
  organization = tfe_organization.org.name
  depends_on   = [tfe_organization_run_task.task]
}
data "tfe_workspace_run_task" "d_ws_task" {
  workspace_id = tfe_workspace.ws.id
  task_id      = tfe_organization_run_task.task.id
  depends_on   = [tfe_workspace_run_task.ws_task]
}
data "tfe_registry_provider" "d_regprov" {
  organization  = tfe_organization.org.name
  registry_name = "private"
  name          = tfe_registry_provider.regprov.name
  depends_on    = [tfe_registry_provider.regprov]
}
data "tfe_registry_providers" "d_regprovs" {
  organization  = tfe_organization.org.name
  registry_name = "private"
  depends_on    = [tfe_registry_provider.regprov]
}
data "tfe_admin_smtp_settings" "d_smtp" {
  depends_on = [tfe_admin_smtp_settings.smtp]
}
data "tfe_organization_tags" "d_tags" {
  organization = tfe_organization.org.name
  depends_on   = [tfe_organization.org]
}
data "tfe_ip_ranges" "d_ipr" {}
data "tfe_org_max_token_ttl_policy" "d_ottl" {
  organization = tfe_organization.org.name
  depends_on   = [tfe_org_max_token_ttl_policy.ottl]
}
data "tfe_registry_module" "d_regmod" {
  organization    = tfe_organization.org.name
  namespace       = tfe_organization.org.name
  registry_name   = "private"
  name            = tfe_registry_module.regmod.name
  module_provider = "aws"
  depends_on      = [tfe_registry_module.regmod]
}
data "tfe_saml_settings" "d_saml" {
  depends_on = [tfe_saml_settings.saml]
}
data "tfe_scim_settings" "d_scim" {
  depends_on = [tfe_scim_settings.scim]
}
data "tfe_provider_set" "d_pset" {
  organization = tfe_organization.org.name
  name         = tfe_provider_set.pset.name
  depends_on   = [tfe_provider_set.pset]
}

output "ds_org_name"     { value = data.tfe_organization.d_org.name }
output "ds_orgs_names"   { value = data.tfe_organizations.d_orgs.names }
output "ds_ws_name"      { value = data.tfe_workspace.d_ws.name }
output "ds_ws2_name"     { value = data.tfe_workspace.d_ws2.name }
output "ds_wsids_full"   { value = data.tfe_workspace_ids.d_wsids.full_names }
output "ds_proj_name"    { value = data.tfe_project.d_proj.name }
output "ds_projs_names"  { value = [for p in data.tfe_projects.d_projs.projects : p.name] }
output "ds_team_name"    { value = data.tfe_team.d_team.name }
output "ds_teams_names"  { value = data.tfe_teams.d_teams.names }
output "ds_vs_name"      { value = data.tfe_variable_set.d_vs.name }
output "ds_vars_vs_count" { value = length(data.tfe_variables.d_vars_vs.terraform) }
output "ds_vars_ws_count" { value = length(data.tfe_variables.d_vars_ws.terraform) }
output "ds_ssh_name"     { value = data.tfe_ssh_key.d_ssh.name }
output "ds_member_email" { value = data.tfe_organization_membership.d_member.email }
output "ds_members_count" { value = length(data.tfe_organization_members.d_members.members) }
output "ds_access"       { value = data.tfe_team_access.d_access.access }
output "ds_proj_access"  { value = data.tfe_team_project_access.d_proj_access.access }
output "ds_ps_name"      { value = data.tfe_policy_set.d_ps.name }
output "ds_oc_name"      { value = data.tfe_oauth_client.d_oc.name }
output "ds_pool_name"    { value = data.tfe_agent_pool.d_pool.name }
output "ds_me_username"  { value = data.tfe_current_user.d_me.username }
output "ds_task_name"    { value = data.tfe_organization_run_task.d_task.name }
output "ds_ws_task_level" { value = data.tfe_workspace_run_task.d_ws_task.enforcement_level }
output "ds_regprov_name"   { value = data.tfe_registry_provider.d_regprov.name }
output "ds_regprovs_count" { value = length(data.tfe_registry_providers.d_regprovs.providers) }
output "ds_smtp_sender"     { value = data.tfe_admin_smtp_settings.d_smtp.sender }
output "ds_tags_count"      { value = length(data.tfe_organization_tags.d_tags.tags) }
output "ds_ipr_api_count"   { value = length(data.tfe_ip_ranges.d_ipr.api) }
output "ds_ottl_org_ttl"    { value = data.tfe_org_max_token_ttl_policy.d_ottl.org_token_max_ttl }
output "ds_regmod_name"     { value = data.tfe_registry_module.d_regmod.name }
output "ds_saml_enabled"    { value = data.tfe_saml_settings.d_saml.enabled }
output "ds_scim_enabled"    { value = data.tfe_scim_settings.d_scim.enabled }
output "ds_pset_name"       { value = data.tfe_provider_set.d_pset.name }
`;
}

// Reads the real run's outputs from the workspace state (tfe_outputs),
// written into the workspace only after planAndApply commits a state version.
function stateOutputsTf(suffix: string, scimMapping = ""): string {
  return `data "tfe_outputs" "d_out" {
  workspace    = "pe2e-ws-${suffix}"
  organization = "pe2e-org-${suffix}"
}
output "run_output_value" { value = data.tfe_outputs.d_out.nonsensitive_values["probe_output"] }
${scimMapping}
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

output "probe_output" {
  value = "probe-value-pe2e"
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
      const planLog = await api(port, "GET", `/api/v2/runs/${runId}/plan/log`, undefined, token);
      const applyLog = await api(port, "GET", `/api/v2/runs/${runId}/apply/log`, undefined, token);
      throw new Error(`run ${runId} ended with status "${status}":\n--- plan ---\n${planLog.text.slice(-1500)}\n--- apply ---\n${applyLog.text.slice(-1500)}`);
    }
  }
  expect(status, `run ${runId} did not reach applied`).toBe("applied");

  // The state version is committed together with the run status, but under
  // full-suite load the request can still race the commit. Poll for it.
  let sv = await api(port, "GET", `/api/v2/workspaces/${wsId}/current-state-version`, undefined, token);
  for (let i = 0; i < 60 && sv.status !== 200; i++) {
    await sleep(500);
    sv = await api(port, "GET", `/api/v2/workspaces/${wsId}/current-state-version`, undefined, token);
  }
  expect(sv.status, `current-state-version for workspace ${wsId} did not become available (last status ${sv.status}): ${sv.text.slice(0, 300)}`).toBe(200);
  const resources = sv.json.data.attributes.resources as { name: string; type: string }[];
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
    // Sweep STALE E2E/test dirs left by interrupted/killed runs (SIGKILL
    // never reaches each file's afterAll/teardown). The backend dirs
    // (~222-309 MB on tmpfs) accumulate and OOM-kill the container if left
    // behind. Only delete dirs older than 10 minutes — bun runs test files
    // concurrently, so active shared setup dirs (recent mtime) must be spared.
    const now = Date.now();
    for (const name of readdirSync(tmpdir())) {
      if (!(name.startsWith("terrence-test-") || name.startsWith("terrence-provider-e2e-"))) continue;
      try {
        const st = statSync(join(tmpdir(), name));
        if (st.mtimeMs < now - 10 * 60 * 1000) {
          await rm(join(tmpdir(), name), { recursive: true, force: true }).catch(() => undefined);
        }
      } catch {
        /* ignore races */
      }
    }
    const { ensureBinary } = await import("../../src/binaryManager");
    const terraform = await ensureBinary("terraform");
    const tofu = await ensureBinary("tofu");
    if (terraform === null || tofu === null) throw new Error("could not obtain terraform and tofu binaries (network required)");
    terraformBin = terraform.binaryPath;
    tofuBin = tofu.binaryPath;
  }, 300_000);

  for (const cliName of ["terraform", "tofu"] as const) {
    if (e2eCliFilter !== null && cliName !== e2eCliFilter) continue;
    test(`latest hashicorp/tfe provider: full lifecycle against Terrence via ${cliName} CLI`, async () => {
      const bin = cliName === "terraform" ? terraformBin : tofuBin;
      const suffix = `${cliName}${Date.now().toString(36)}`;
      const workDir = mkdtempSync(join(tmpdir(), `terrence-provider-e2e-${suffix}-`));
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
          await writeFile(join(cfgDir, "providers.tf"), providerTf(proxy.port!, auth.token));
          await writeFile(join(cfgDir, "main.tf"), mainTf(suffix, auth.username));
          await writeFile(join(cfgDir, "outputs.tf"), outputsTf());

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

          // Every data source must resolve and produce its expected value.
          const outs = await cli(bin, ["output", "-json", "-no-color"], cfgDir, cliEnv);
          cliOk(outs, "output");
          const o = JSON.parse(outs.out) as Record<string, { value: unknown }>;
          const val = (key: string): unknown => {
            if (!(key in o)) throw new Error(`output ${key} missing; available: ${Object.keys(o).join(",")}`);
            return o[key]!.value;
          };
          expect(val("ds_org_name")).toBe(`pe2e-org-${suffix}`);
          expect(val("ds_orgs_names")).toEqual(expect.arrayContaining([`pe2e-org-${suffix}`]));
          expect(val("ds_ws_name")).toBe(`pe2e-ws-${suffix}`);
          expect(val("ds_ws2_name")).toBe(`pe2e-ws2-${suffix}`);
          expect(Object.values(val("ds_wsids_full") as Record<string, string>)).toEqual(expect.arrayContaining([`pe2e-org-${suffix}/pe2e-ws-${suffix}`]));
          expect(val("ds_proj_name")).toBe(`pe2e-proj-${suffix}`);
          expect(val("ds_projs_names")).toEqual(expect.arrayContaining([`pe2e-proj-${suffix}`]));
          expect(val("ds_team_name")).toBe(`pe2e-team-${suffix}`);
          expect(val("ds_teams_names")).toEqual(expect.arrayContaining([`pe2e-team-${suffix}`]));
          expect(val("ds_vs_name")).toBe(`pe2e-vs-${suffix}`);
          expect(val("ds_vars_vs_count")).toBeGreaterThan(0);
          expect(val("ds_vars_ws_count")).toBeGreaterThan(0);
          expect(val("ds_ssh_name")).toBe(`pe2e-ssh-${suffix}`);
          expect(val("ds_member_email")).toBe(`pe2e+${suffix}@example.com`);
          expect(Number(val("ds_members_count"))).toBeGreaterThan(0);
          expect(val("ds_access")).toBe("plan");
          expect(val("ds_proj_access")).toBe("write");
          expect(val("ds_ps_name")).toBe(`pe2e-ps-${suffix}`);
          expect(val("ds_oc_name")).toBe(`pe2e-oauth-${suffix}`);
          expect(val("ds_pool_name")).toBe(`pe2e-pool-${suffix}`);
          expect(val("ds_me_username")).toBe(auth.username);
          expect(val("ds_task_name")).toBe(`pe2e-task-${suffix}`);
          expect(val("ds_ws_task_level")).toBe("advisory");
          expect(val("ds_regprov_name")).toBe(`pe2e-prov-${suffix}`);
          expect(Number(val("ds_regprovs_count"))).toBeGreaterThan(0);
          expect(val("ds_smtp_sender")).toBe("pe2e@example.com");
          expect(Number(val("ds_tags_count"))).toBeGreaterThanOrEqual(0);
          expect(Number(val("ds_ipr_api_count"))).toBeGreaterThan(0);
          expect(val("ds_ottl_org_ttl")).toBe("1d");
          expect(val("ds_regmod_name")).toBe(`pe2e-mod-${suffix}`);
          expect(val("ds_saml_enabled")).toBe(true);
          expect(val("ds_scim_enabled")).toBe(true);
          expect(val("ds_pset_name")).toBe(`pe2e-pset-${suffix}`);

          await planAndApply(backend.port, auth.token, `pe2e-org-${suffix}`, `pe2e-ws-${suffix}`, workDir);

          // tfe_scim_group_mapping needs a provisioned SCIM group (created via
          // the SCIM API with a SCIM bearer token). The group can't be created
          // by Terraform itself, so provision it here between applies using an
          // admin-issued SCIM token, then reference it in the second apply.
          let scimMapping = "";
          let scimMappingTf = "";
          {
            const scimTokRes = await api(backend.port, "POST", "/api/v2/admin/scim-tokens", {
              data: { type: "authentication-tokens", attributes: { description: `e2e-scim-${suffix}` } },
            }, auth.token);
            if (scimTokRes.status === 201) {
              const scimRaw = scimTokRes.json.data.attributes.token as string;
              const groupRes = await fetch(`http://127.0.0.1:${backend.port}/scim/v2/Groups`, {
                method: "POST",
                headers: { "Content-Type": "application/scim+json", Authorization: `Bearer ${scimRaw}` },
                body: JSON.stringify({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: `pe2e-scim-group-${suffix}` }),
              });
              if (groupRes.status === 201) {
                const scimGroupId = (await groupRes.json() as { id: string }).id;
                const teamsRes = await api(backend.port, "GET", `/api/v2/organizations/pe2e-org-${suffix}/teams`, undefined, auth.token);
                const team = (teamsRes.json.data as { id: string; attributes: { name: string } }[]).find((t): boolean => t.attributes.name === `pe2e-team-${suffix}`);
                if (team !== undefined) {
                  scimMapping = scimGroupId;
                  scimMappingTf = `resource "tfe_scim_group_mapping" "sgm" {
  team_id       = "${team.id}"
  scim_group_id = "${scimGroupId}"
}
`;
                }
              }
            }
          }

          // tfe_outputs reads the real run's state outputs (available only
          // after planAndApply committed a state version).
          await writeFile(join(cfgDir, "build-outputs.tf"), stateOutputsTf(suffix, scimMappingTf));
          const outApply = await cli(bin, ["apply", "-auto-approve", "-input=false", "-no-color"], cfgDir, cliEnv);
          cliOk(outApply, "build outputs apply");
          const outJson = await cli(bin, ["output", "-json", "-no-color"], cfgDir, cliEnv);
          const o2 = JSON.parse(outJson.out) as Record<string, { value: unknown }>;
          expect(o2["run_output_value"]!.value).toBe("probe-value-pe2e");
          if (scimMapping !== "") {
            // The SCIM group mapping was created in the second apply.
            const stateList2 = await cli(bin, ["state", "list"], cfgDir, cliEnv);
            cliOk(stateList2, "state list #2");
            expect(stateList2.out).toContain("tfe_scim_group_mapping.sgm");
          }
          await rm(join(cfgDir, "build-outputs.tf"), { force: true });

          const destroy = await cli(bin, ["destroy", "-auto-approve", "-input=false", "-no-color"], cfgDir, cliEnv);
          cliOk(destroy, "destroy");
          expect(destroy.out).toContain("Destroy complete");
        } finally {
          await proxy.stop(true);
        }
      } finally {
        backend.proc.kill();
        // The backend's temp dir (db + downloaded terraform/tofu binaries,
        // ~300 MB) is on tmpfs (/tmp) and is otherwise never cleaned up;
        // leaving it behind fills the container's 8 GB cgroup RAM and OOM-kills
        // unrelated processes (the Hermes gateway), so remove it unless a debug
        // flag asks to keep it.
        if (process.env.TERRENCE_E2E_KEEP_BACKEND_DIR === "1") {
          console.log(`[e2e] backend kept: ${backend.storageDir}`);
        } else {
          await rm(backend.storageDir, { recursive: true, force: true }).catch(() => undefined);
        }
        if (process.env.TERRENCE_E2E_KEEP_WORKDIR === "1") {
          console.log(`[e2e] workdir kept: ${workDir}`);
        } else {
          await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }, 900_000);
  }
});
