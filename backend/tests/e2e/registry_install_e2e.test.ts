import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, openSync, closeSync } from "node:fs";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { makeRegistryModuleArchive } from "../registry-module-helpers";
import cliMatrix from "./cli_matrix.json";

/**
 * Genuine registry installation (COMP-10, issue #720).
 *
 * Local prerequisite: `backend/bin/terraform-config-inspect` must exist
 * (same pinned revision the prod Dockerfile bakes in; CI builds it in the
 * backend jobs). Without it the module-publish uploads fail closed with a
 * 422 naming the missing binary instead of passing.
 *
 * The API contract suites assert response shapes with fixture rows; this
 * suite runs real `terraform`/`tofu` CLIs against a booted backend behind
 * the same TLS-terminating loopback proxy the provider journeys use:
 * module discovery/install through the advertised endpoints, version
 * ordering and selection, a provider network-mirror download with hash
 * verification, tamper rejection, and the anonymous/private boundaries.
 */
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const BACKEND_DIR = join(REPO_ROOT, "backend");
const SHARED_BINARY_CACHE = join(BACKEND_DIR, "storage", "binaries");

const sleep = (ms: number): Promise<void> => new Promise((resolveFn) => setTimeout(resolveFn, ms));

const MATRIX_TIER = process.env["TERRENCE_E2E_TIER"] ?? "current";
if (!["floor", "current", "canary"].includes(MATRIX_TIER)) throw new Error("TERRENCE_E2E_TIER must be floor, current or canary");
const E2E_CLI_FILTER: string | null = process.env["TERRENCE_E2E_CLI"] ?? null;
if (E2E_CLI_FILTER !== null && !["terraform", "tofu"].includes(E2E_CLI_FILTER)) throw new Error("Unsupported TERRENCE_E2E_CLI value");

type Cli = { tool: "terraform" | "tofu"; bin: string };
type CliResult = { code: number; out: string; err: string };

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

async function cli(bin: string, args: string[], cwd: string, env: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn([bin, ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, out, err };
}

async function api(port: number, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, any> }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) { headers["Content-Type"] = "application/vnd.api+json"; }
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
  });
  let json: Record<string, any> = {};
  try { json = await res.json() as Record<string, any>; } catch { /* non-JSON (204/404) */ }
  return { status: res.status, json };
}

type Backend = { port: number; proc: Bun.Subprocess; dbDir: string; logPath: string };

async function startBackend(workDir: string): Promise<Backend> {
  const dbDir = mkdtempSync(join(tmpdir(), "terrence-registry-e2e-"));
  const databaseUrl = `file:${join(dbDir, "test.db")}`;
  const port = await freePort();
  const logPath = join(workDir, "server.log");
  const logFd = openSync(logPath, "w", 0o600);
  let proc: Bun.Subprocess | undefined;
  try {
    proc = Bun.spawn(["bun", "run", "index.ts"], {
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        DATABASE_URL: databaseUrl,
        STORAGE_DIR: dbDir,
        TERRENCE_JWT_SECRET: "registry-e2e-secret",
        ADMIN_PASSWORD: "re2e-admin-password-123",
        TERRENCE_RUN_SANDBOX: "false",
        TERRENCE_ENABLE_LOCAL_SIGNUP: "true",
        SIMULATED_RUNS: "false",
        TERRENCE_BINARY_CACHE_DIR: SHARED_BINARY_CACHE,
        TERRENCE_DISABLE_WORKER: "0",
        TERRENCE_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
      },
      stdout: logFd,
      stderr: logFd,
    });
  } finally { closeSync(logFd); }
  for (let i = 0; i < 300; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return { port, proc: proc as Bun.Subprocess, dbDir, logPath };
    } catch { /* not up yet */ }
    if ((proc as Bun.Subprocess | undefined)?.exitCode !== null) break;
    await sleep(200);
  }
  const tail = (await readFile(logPath, "utf8").catch(() => "")).split("\n").slice(-60).join("\n");
  throw new Error(`backend failed to start within 60s\n${tail}`);
}

async function startTlsProxy(backendPort: number, workDir: string): Promise<{ server: Awaited<ReturnType<typeof Bun.serve>>; port: number; certPath: string }> {
  const port = await freePort();
  // Self-signed loopback CA with real CA extensions: both engines must
  // accept it as an authority (a bare -x509 cert fails Go verification).
  // The identity covers both loopback addresses so a second proxy can serve
  // the port-less 127.0.0.2:443 identity provider sources require.
  const proc = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,IP:127.0.0.2", "-addext", "basicConstraints=critical,CA:true", "-addext", "keyUsage=critical,keyCertSign,digitalSignature,keyEncipherment", "-keyout", join(workDir, "key.pem"), "-out", join(workDir, "cert.pem")], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (await proc.exited !== 0) throw new Error("Could not create TLS fixture certificate");
  const cert = await Bun.file(join(workDir, "cert.pem")).arrayBuffer();
  const key = await Bun.file(join(workDir, "key.pem")).arrayBuffer();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    tls: { cert, key },
    fetch: proxyFetch(backendPort),
  });
  return { server, port, certPath: join(workDir, "cert.pem") };
}

/** Reverse-proxy fetch handler shared by both TLS proxies. */
function proxyFetch(backendPort: number): (req: Request) => Promise<Response> {
  return (req): Promise<Response> => {
    const url = new URL(req.url);
    url.protocol = "http";
    url.host = `127.0.0.1:${backendPort}`;
    const headers = new Headers(req.headers);
    headers.set("X-Forwarded-Host", new URL(req.url).host);
    headers.set("X-Forwarded-Proto", "https");
    return fetch(new Request(new Request(url, req), { headers }));
  };
}

/**
 * Port-less provider identity (127.0.0.2:443). Neither engine accepts a port
 * in a provider source hostname, so the genuine mirror install needs a
 * loopback address on the default TLS port. Returns null when the port
 * cannot be bound (unprivileged CI runners); callers skip the CLI install
 * and keep the always-run metadata assertions below.
 */
async function tryStartPortlessProxy(backendPort: number, workDir: string): Promise<{ server: Awaited<ReturnType<typeof Bun.serve>> } | null> {
  const cert = await Bun.file(join(workDir, "cert.pem")).arrayBuffer();
  const key = await Bun.file(join(workDir, "key.pem")).arrayBuffer();
  try {
    const server = Bun.serve({
      hostname: "127.0.0.2",
      port: 443,
      tls: { cert, key },
      fetch: proxyFetch(backendPort),
    });
    return { server };
  } catch {
    return null;
  }
}

/** Static file origin for the provider fixture archive, over the same TLS identity. */
async function startFixtureOrigin(workDir: string, files: Readonly<Record<string, Uint8Array>>): Promise<{ server: Awaited<ReturnType<typeof Bun.serve>>; port: number }> {
  const port = await freePort();
  const cert = await Bun.file(join(workDir, "cert.pem")).arrayBuffer();
  const key = await Bun.file(join(workDir, "key.pem")).arrayBuffer();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    tls: { cert, key },
    fetch: (req): Response => {
      const name = new URL(req.url).pathname.replace(/^\//, "");
      const body = files[name];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(body as unknown as BodyInit, { headers: { "Content-Type": "application/zip" } });
    },
  });
  return { server, port };
}

const suffix = randomUUID().slice(0, 8);
const orgName = `rege2e-org-${suffix}`;
const moduleName = "demo";
const moduleProvider = "aws";
const providerType = "customcloud";

const clis: Cli[] = [];
let workDir = "";
let backend: Backend | undefined;
let proxy: { server: Awaited<ReturnType<typeof Bun.serve>>; port: number; certPath: string } | undefined;
let portless: { server: Awaited<ReturnType<typeof Bun.serve>> } | null = null;
let token = "";
let cliEnvBase: Record<string, string> = {};

async function ensureCli(tool: "terraform" | "tofu"): Promise<string> {
  const { ensureBinary } = await import("../../src/binaryManager");
  const version = (cliMatrix as Record<string, Record<string, string>>)[tool]?.[MATRIX_TIER === "floor" ? "floor" : "current"] ?? "latest";
  const binary = await ensureBinary(tool, version);
  if (binary === null) throw new Error(`Could not obtain ${tool} binary`);
  return binary.binaryPath;
}

describe("genuine registry installation", () => {
  beforeAll(async () => {
    for (const tool of ["terraform", "tofu"] as const) {
      if (E2E_CLI_FILTER !== null && E2E_CLI_FILTER !== tool) continue;
      clis.push({ tool, bin: await ensureCli(tool) });
    }
    expect(clis.length).toBeGreaterThan(0);
    workDir = mkdtempSync(join(tmpdir(), "terrence-registry-install-"));
    backend = await startBackend(workDir);
    proxy = await startTlsProxy(backend.port, workDir);
    portless = await tryStartPortlessProxy(backend.port, workDir);

    // First-boot admin: log in, change the provisional password, re-login.
    const login = await api(backend.port, "POST", "/api/v2/users/login", {
      data: { attributes: { username: "admin", password: "re2e-admin-password-123" } },
    });
    expect(login.status).toBe(200);
    const tempToken = login.json["data"].attributes.token as string;
    const pwRes = await api(backend.port, "PATCH", "/api/v2/account/password", {
      data: {
        attributes: {
          "current-password": "re2e-admin-password-123",
          password: "re2e-admin-password-456",
          "password-confirmation": "re2e-admin-password-456",
        },
      },
    }, tempToken);
    expect(pwRes.status).toBe(200);
    const finalLogin = await api(backend.port, "POST", "/api/v2/users/login", {
      data: { attributes: { username: "admin", password: "re2e-admin-password-456" } },
    });
    expect(finalLogin.status).toBe(200);
    token = finalLogin.json["data"].attributes.token as string;

    const org = await api(backend.port, "POST", "/api/v2/organizations", {
      data: { type: "organizations", attributes: { name: orgName, email: "rege2e@example.com" } },
    }, token);
    expect(org.status).toBe(201);

    cliEnvBase = {
      SSL_CERT_FILE: proxy.certPath,
      TF_CLI_CONFIG_FILE: join(workDir, "cli.tfrc"),
      CHECKPOINT_DISABLE: "1",
      TF_IN_AUTOMATION: "1",
    };
    await writeFile(join(workDir, "cli.tfrc"), `credentials "127.0.0.1:${proxy.port}" {\n  token = "${token}"\n}\ncredentials "127.0.0.2" {\n  token = "${token}"\n}\n`);

    // Publish module versions 1.0.0 and 2.0.0 with real archives.
    const created = await api(backend.port, "POST", `/api/v2/organizations/${orgName}/registry-modules`, {
      data: { attributes: { name: moduleName, provider: moduleProvider, namespace: orgName } },
    }, token);
    expect(created.status).toBe(201);
    const moduleId = created.json["data"].id as string;
    for (const version of ["1.0.0", "2.0.0"]) {
      const moduleDir = join(workDir, `module-${version}`);
      await mkdir(moduleDir, { recursive: true });
      await writeFile(join(moduleDir, "main.tf"), `output "greeting" {\n  value = "hello from ${version}"\n}\n`);
      const archive = join(workDir, `module-${version}.tar.gz`);
      await makeRegistryModuleArchive(archive, moduleDir);
      const ver = await api(backend.port, "POST", `/api/v2/registry-modules/${moduleId}/versions`, {
        data: { type: "registry-module-versions", attributes: { version } },
      }, token);
      expect(ver.status).toBe(201);
      const versionId = ver.json["data"].id as string;
      const archiveBytes = await Bun.file(archive).arrayBuffer();
      const upload = await fetch(`http://127.0.0.1:${backend.port}/api/v2/registry-module-versions/${versionId}/upload`, {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/octet-stream" },
        body: archiveBytes,
      });
      expect({ version, status: upload.status, body: await upload.text() }).toMatchObject({ version, status: 200 });
    }
  }, 300_000);

  afterAll(async () => {
    await proxy?.server.stop(true);
    await portless?.server.stop(true);
    await fixtureOrigin?.server.stop(true);
    if (backend !== undefined) {
      backend.proc.kill();
      await backend.proc.exited;
      await rm(backend.dbDir, { recursive: true, force: true });
    }
    await rm(workDir, { recursive: true, force: true });
  });

  test.each([["terraform"], ["tofu"]])("%s installs the latest module version through discovery", async (tool) => {
    const target = clis.find((c): boolean => c.tool === tool);
    if (target === undefined) return;
    const dir = join(workDir, `install-${tool}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "main.tf"), `module "demo" {\n  source = "127.0.0.1:${proxy?.port}/${orgName}/${moduleName}/${moduleProvider}"\n}\n`);
    const init = await cli(target.bin, ["init", "-input=false", "-no-color"], dir, cliEnvBase);
    expect(init.code).toBe(0);
    expect(init.out).toContain("has been successfully initialized!");
    const modulesJson = JSON.parse(await readFile(join(dir, ".terraform/modules/modules.json"), "utf8")) as {
      Modules: { Key: string; Version: string; Dir: string }[];
    };
    const demo = modulesJson.Modules.find((m): boolean => m.Key === "demo");
    expect(demo?.Version).toBe("2.0.0");
    expect(await readFile(join(dir, demo?.Dir ?? "", "main.tf"), "utf8")).toContain("hello from 2.0.0");
  }, 180_000);

  test.each([["terraform"], ["tofu"]])("%s honors an exact version pin", async (tool) => {
    const target = clis.find((c): boolean => c.tool === tool);
    if (target === undefined) return;
    const dir = join(workDir, `pinned-${tool}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "main.tf"), `module "demo" {\n  source  = "127.0.0.1:${proxy?.port}/${orgName}/${moduleName}/${moduleProvider}"\n  version = "1.0.0"\n}\n`);
    const init = await cli(target.bin, ["init", "-input=false", "-no-color"], dir, cliEnvBase);
    expect({ tool, code: init.code }).toMatchObject({ tool, code: 0 });
    const modulesJson = JSON.parse(await readFile(join(dir, ".terraform/modules/modules.json"), "utf8")) as {
      Modules: { Key: string; Version: string }[];
    };
    expect(modulesJson.Modules.find((m): boolean => m.Key === "demo")?.Version).toBe("1.0.0");
  }, 180_000);

  test.each([["terraform"], ["tofu"]])("%s reports a missing version as a version error, not a discovery failure", async (tool) => {
    const target = clis.find((c): boolean => c.tool === tool);
    if (target === undefined) return;
    const dir = join(workDir, `missing-${tool}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "main.tf"), `module "demo" {\n  source  = "127.0.0.1:${proxy?.port}/${orgName}/${moduleName}/${moduleProvider}"\n  version = "9.9.9"\n}\n`);
    const init = await cli(target.bin, ["init", "-input=false", "-no-color"], dir, cliEnvBase);
    expect(init.code).not.toBe(0);
    // A version error, not a discovery failure: terraform names the newest
    // available version instead of failing to reach the registry.
    expect(init.err).toMatch(/no available version|not found|2\.0\.0/i);
  }, 180_000);

  test("anonymous clients cannot read the private registry surface", async () => {
    if (backend === undefined) throw new Error("backend did not start");
    const versions = await fetch(`http://127.0.0.1:${backend.port}/api/registry/v1/modules/${orgName}/${moduleName}/${moduleProvider}/versions`);
    expect(versions.status).toBe(404);
    const authed = await api(backend.port, "GET", `/api/registry/v1/modules/${orgName}/${moduleName}/${moduleProvider}/versions`, undefined, token);
    expect(authed.status).toBe(200);
  });

  // Provider fixtures: one good platform checksum, one tampered. Published
  // once via the management API; the metadata test and the CLI install test
  // below share them.
  let providerShasum = "";
  let fixtureOrigin: { server: Awaited<ReturnType<typeof Bun.serve>>; port: number } | undefined;
  let providerPublished = false;
  async function publishProviderFixture(): Promise<void> {
    if (providerPublished || backend === undefined) return;
    // The fixture is representative bytes rather than a real provider build:
    // init downloads it, verifies the zh: hash, then fails unpacking it as
    // a zip. That failure location is the assertion: anything earlier
    // (discovery, auth, hash) failing means the transport regressed.
    const fixtureBytes = new TextEncoder().encode(`terrence registry mirror fixture ${suffix}\n`);
    providerShasum = createHash("sha256").update(fixtureBytes).digest("hex");
    fixtureOrigin = await startFixtureOrigin(workDir, { "customcloud.zip": fixtureBytes });
    const created = await api(backend.port, "POST", `/api/v2/organizations/${orgName}/registry-providers`, {
      data: { attributes: { name: providerType, namespace: orgName } },
    }, token);
    expect(created.status).toBe(201);
    for (const [version, sum] of [["1.0.0", providerShasum], ["2.0.0", "0".repeat(64)]] as const) {
      const ver = await api(backend.port, "POST", `/api/v2/organizations/${orgName}/registry-providers/private/${orgName}/${providerType}/versions`, {
        data: { type: "registry-provider-versions", attributes: { version, protocols: ["5.0"] } },
      }, token);
      expect(ver.status).toBe(201);
      const plat = await api(backend.port, "POST", `/api/v2/organizations/${orgName}/registry-providers/private/${orgName}/${providerType}/versions/${version}/platforms`, {
        data: {
          type: "registry-provider-platforms",
          attributes: {
            os: "linux", arch: "amd64",
            filename: `terraform-provider-customcloud_${version}_linux_amd64.zip`,
            "download-url": `https://127.0.0.1:${fixtureOrigin.port}/customcloud.zip`,
            shasum: sum,
          },
        },
      }, token);
      expect(plat.status).toBe(201);
    }
    providerPublished = true;
  }

  test("network mirror metadata carries versions and hashes behind auth", async () => {
    if (backend === undefined) throw new Error("backend did not start");
    await publishProviderFixture();
    // Anonymous reads of the private mirror surface stay hidden, while the
    // owner sees versions and per-platform hashes.
    // Direct-backend assertions address the mirror by the backend's own host:
    // hostname matching compares against the request URL, not the proxy.
    const mirrorBase = `/api/registry/v1/provider-mirror/127.0.0.1:${backend.port}/${orgName}/${providerType}`;
    expect((await fetch(`http://127.0.0.1:${backend.port}${mirrorBase}/index.json`)).status).toBe(404);
    const index = await api(backend.port, "GET", `${mirrorBase}/index.json`, undefined, token);
    expect(index.status).toBe(200);
    expect(index.json).toEqual({ versions: { "1.0.0": {}, "2.0.0": {} } });
    const versionDoc = await api(backend.port, "GET", `${mirrorBase}/1.0.0.json`, undefined, token);
    expect(versionDoc.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/dot-notation -- Record<string, any> must use brackets under noPropertyAccessFromIndexSignature
    expect(versionDoc.json["archives"]["linux_amd64"]["hashes"]).toEqual([`zh:${providerShasum}`]);
    // Through the reverse proxy the same surface answers under the outward
    // host, which is what the CLI mirror client actually requests.
    if (proxy !== undefined) {
      const viaProxy = await fetch(`https://127.0.0.1:${proxy.port}/api/registry/v1/provider-mirror/127.0.0.1:${proxy.port}/${orgName}/${providerType}/index.json`, {
        headers: { Authorization: "Bearer " + token },
        tls: { rejectUnauthorized: true, ca: await Bun.file(join(workDir, "cert.pem")).text() },
      }).catch(() => null);
      expect(viaProxy?.status).toBe(200);
    }
  });

  // A genuine package download through the mirror needs a port-less registry
  // hostname: neither engine accepts a port in a provider source. That needs
  // 127.0.0.2:443 (CI opens it with a best-effort sysctl); the install below
  // runs where the port is available and skips elsewhere, while the
  // metadata test above always runs. (`providers mirror` stays unusable
  // against private registries on both engines: it re-fetches the origin
  // download document without credentials, so providers always fail closed
  // there; `init` is the genuine consumption path.)
  test.each([["terraform"], ["tofu"]])("%s installs a provider through the network mirror and verifies its checksum", async (tool) => {
    const target = clis.find((c): boolean => c.tool === tool);
    if (target === undefined || backend === undefined) return;
    await publishProviderFixture();
    if (portless === null || fixtureOrigin === undefined) {
      console.warn(`[registry_install_e2e] skipping genuine ${tool} provider install: 127.0.0.2:443 unavailable`);
      return;
    }
    const host = "127.0.0.2";
    const dir = join(workDir, `mirror-${tool}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "mirror.tfrc"), `credentials "${host}" {\n  token = "${token}"\n}\nprovider_installation {\n  network_mirror {\n    url = "https://${host}/api/registry/v1/provider-mirror/"\n  }\n}\n`);
    await writeFile(join(dir, "main.tf"), `terraform {\n  required_providers {\n    customcloud = {\n      source  = "${host}/${orgName}/${providerType}"\n      version = "1.0.0"\n    }\n  }\n}\n`);
    const mirrorEnv = { ...cliEnvBase, TF_CLI_CONFIG_FILE: join(dir, "mirror.tfrc") };
    const installed = await cli(target.bin, ["init", "-input=false", "-no-color"], dir, mirrorEnv);
    expect(installed.code).not.toBe(0);
    const installedOutput = `${installed.out}\n${installed.err}`;
    // Past discovery, auth, download and hash verification: the only
    // remaining failure is unpacking fixture bytes as a provider zip.
    expect(installedOutput).toMatch(/not a valid zip file/i);
    expect(installedOutput).not.toMatch(/checksum|hash|mismatch|signature|integrity|401|403|404|refused|certificate|unknown authority/i);

    // A published checksum that does not match the bytes fails closed.
    await writeFile(join(dir, "main.tf"), `terraform {\n  required_providers {\n    customcloud = {\n      source  = "${host}/${orgName}/${providerType}"\n      version = "2.0.0"\n    }\n  }\n}\n`);
    const tampered = await cli(target.bin, ["init", "-input=false", "-no-color"], dir, mirrorEnv);
    expect(tampered.code).not.toBe(0);
    expect(`${tampered.out}\n${tampered.err}`).toMatch(/checksum|hash|signature|integrity|mismatch|does not match/i);
  }, 240_000);
});
