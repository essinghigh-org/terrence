import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, rename, copyFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "bun";
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { envEnabled } from "./env";
import { db } from "../db";
import {
  githubAppInstallations,
  oauthClients,
  oauthTokens,
  stackAgentJobs,
  durableJobs,
  stackRecords,
  stackStateLocks,
  stacks,
} from "../db/schema";
import { getGitHubAppAccessToken } from "./webhooks";
import { decryptSecret } from "./secrets";
import { fetchResolvedExternalUrl, resolveExternalUrl } from "./url-safety";
import { validateExternalUrl } from "./utils";
import { ensureBinary } from "../binaryManager";
import { extractValidatedModuleArchive, validateModuleArchive } from "./registry-module-archive";
import { enqueueDurableJob, type DurableJobContext } from "./durable-jobs";
import { RunSandbox, removeSandboxWorkDir, runSandboxRequired } from "./sandbox";

const STACK_STORAGE_DIR = join(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"), "stacks");
const MAX_STACK_ARCHIVE_BYTES = 100 * 1024 * 1024;
const STACK_STATE_LOCK_LEASE_MS = 60_000;
type Job = Readonly<typeof durableJobs.$inferSelect>;
type Stack = Readonly<typeof stacks.$inferSelect>;

export function isStackStoragePath(path: string): boolean {
  const root = resolve(STACK_STORAGE_DIR);
  const target = resolve(path);
  return target === root || target.startsWith(`${root}/`);
}

type SourceCredentials = Readonly<{ provider: string; apiUrl: string | null; token: string | null }>;

function payloadId(job: Job, key: string): string {
  const value = job.payload[key];
  if (typeof value !== "string" || value === "") throw new Error(`stack-configuration job is missing ${key}`);
  return value;
}

async function credentialsFor(stack: Stack): Promise<SourceCredentials> {
  if (stack.vcsOAuthTokenId !== null) {
    const token = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, stack.vcsOAuthTokenId) });
    if (token === undefined) throw new Error("The Stack VCS OAuth token is unavailable");
    const client = await db.query.oauthClients.findFirst({ where: and(eq(oauthClients.id, token.oauthClientId), eq(oauthClients.orgId, stack.orgId)) });
    if (client === undefined) throw new Error("The Stack VCS connection is unavailable");
    return { provider: stack.vcsServiceProvider ?? client.serviceProvider, apiUrl: client.apiUrl, token: await decryptSecret(token.token) };
  }
  if (stack.vcsGhaInstallationId !== null) {
    const installation = await db.query.githubAppInstallations.findFirst({ where: and(eq(githubAppInstallations.id, stack.vcsGhaInstallationId), eq(githubAppInstallations.orgId, stack.orgId)) });
    if (installation === undefined) throw new Error("The Stack GitHub App installation is unavailable");
    const token = await getGitHubAppAccessToken(installation.installationId);
    if (token === null) throw new Error("The Stack GitHub App could not authenticate");
    return { provider: stack.vcsServiceProvider ?? "github", apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com", token };
  }
  return { provider: stack.vcsServiceProvider ?? "github", apiUrl: null, token: null };
}

function providerFamily(provider: string): "github" | "gitlab" | "ado" {
  if (provider === "github" || provider === "github_enterprise") return "github";
  if (provider === "gitlab_hosted" || provider === "gitlab_community_edition" || provider === "gitlab_enterprise_edition" || provider === "gitlab" || provider === "gitlab_ce" || provider === "gitlab_ee") return "gitlab";
  return "ado";
}

function checkedUrl(value: string): string {
  const reason = validateExternalUrl(value, envEnabled(process.env.TERRENCE_ALLOW_PRIVATE_VCS_URLS));
  if (reason !== null) throw new Error(`The Stack VCS URL is unsafe: ${reason}`);
  return value;
}

async function fetchArchive(url: string, headers: Readonly<Record<string, string>>): Promise<Response> {
  const allowPrivate = envEnabled(process.env.TERRENCE_ALLOW_PRIVATE_VCS_URLS);
  let nextUrl = url;
  let requestHeaders: Readonly<Record<string, string>> = headers;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const resolved = await resolveExternalUrl(nextUrl, allowPrivate);
    if ("error" in resolved) throw new Error(`The Stack VCS URL is unsafe: ${resolved.error}`);
    const response = await fetchResolvedExternalUrl(resolved.target, {
      method: "GET",
      headers: requestHeaders,
      timeoutMs: 30_000,
      maxResponseBytes: MAX_STACK_ARCHIVE_BYTES,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (location === null || location === "") throw new Error(`The Stack source download redirected without a location (HTTP ${response.status})`);
    try {
      const redirected = new URL(location, nextUrl);
      if (redirected.origin !== new URL(nextUrl).origin) {
        const withoutAuthorization = { ...requestHeaders };
        delete withoutAuthorization.Authorization;
        requestHeaders = withoutAuthorization;
      }
      nextUrl = redirected.toString();
    } catch {
      throw new Error("The Stack source download returned an invalid redirect location");
    }
  }
  throw new Error("The Stack source download exceeded the redirect limit");
}

async function writeResponseArchive(response: Response, destination: string): Promise<void> {
  if (!response.ok || response.body === null) throw new Error(`The Stack source download failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_STACK_ARCHIVE_BYTES) throw new Error("The Stack source download is too large");
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const file = Bun.file(temporary);
  const writer = file.writer();
  let total = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_STACK_ARCHIVE_BYTES) throw new Error("The Stack source download is too large");
      await writer.write(next.value);
    }
    await writer.end();
    await rename(temporary, destination);
  } finally {
    try { await writer.end(); } catch { /* already closed */ }
    await rm(temporary, { force: true });
  }
}

async function fetchHttpArchive(stack: Stack, destination: string): Promise<void> {
  const credentials = await credentialsFor(stack);
  const identifier = stack.vcsIdentifier ?? "";
  if (identifier === "") throw new Error("The Stack VCS repository identifier is empty");
  const branch = stack.vcsBranch ?? "main";
  const family = providerFamily(credentials.provider);
  const api = credentials.apiUrl?.replace(/\/$/, "");
  const url = family === "github"
    ? `${api ?? "https://api.github.com"}/repos/${identifier.split("/").map(encodeURIComponent).join("/")}/tarball/${encodeURIComponent(branch)}`
    : `${api ?? "https://gitlab.com/api/v4"}/projects/${encodeURIComponent(identifier)}/repository/archive.tar.gz?sha=${encodeURIComponent(branch)}`;
  const headers: Record<string, string> = { "User-Agent": "Terrence", Accept: "application/octet-stream" };
  if (credentials.token !== null) headers.Authorization = `Bearer ${credentials.token}`;
  await writeResponseArchive(await fetchArchive(url, headers), destination);
}

async function fetchGitArchive(stack: Stack, destination: string): Promise<void> {
  const credentials = await credentialsFor(stack);
  const family = providerFamily(credentials.provider);
  const repository = stack.vcsRepositoryHttpUrl ?? `https://${family === "ado" ? "dev.azure.com" : family === "gitlab" ? "gitlab.com" : "github.com"}/${stack.vcsIdentifier ?? ""}.git`;
  const url = checkedUrl(repository);
  const staging = await mkdtemp(join(tmpdir(), "terrence-stack-git-"));
  const cloneDirectory = join(staging, "repo");
  const branch = stack.vcsBranch;
  const args = ["git", "clone", "--depth=1", "--no-tags", ...(branch === null ? [] : ["--branch", branch]), url, cloneDirectory];
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", GIT_TERMINAL_PROMPT: "0" };
  if (credentials.token !== null) {
    const auth = family === "ado" ? `Basic ${Buffer.from(`:${credentials.token}`).toString("base64")}` : `Bearer ${credentials.token}`;
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: ${auth}`;
  }
  try {
    const child = spawn(args, { env, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr.trim() || "git clone failed");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const archive = spawn(["tar", "-czf", destination, "--exclude=.git", "-C", cloneDirectory, "."], { stdout: "pipe", stderr: "pipe" });
    const [archiveExit, archiveError] = await Promise.all([archive.exited, new Response(archive.stderr).text()]);
    if (archiveExit !== 0) throw new Error(archiveError.trim() || "The Stack source archive could not be created");
    if ((await stat(destination)).size > MAX_STACK_ARCHIVE_BYTES) throw new Error("The Stack source archive is too large");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function fetchStackArchive(stack: Stack, destination: string): Promise<void> {
  const family = providerFamily(stack.vcsServiceProvider ?? "github");
  let httpError: unknown;
  if (family === "github" || family === "gitlab") {
    try {
      await fetchHttpArchive(stack, destination);
      return;
    } catch (error: unknown) {
      if (stack.vcsRepositoryHttpUrl === null) throw error;
      httpError = error;
    }
  }
  try {
    await fetchGitArchive(stack, destination);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    const cause = httpError instanceof Error ? ` (archive download failed first: ${httpError.message})` : "";
    throw new Error(`${detail}${cause}`);
  }
}

async function findArchiveRoot(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const dirs = entries.filter((entry) => entry.isDirectory());
  return files.length === 0 && dirs.length === 1 && dirs[0] !== undefined ? join(directory, dirs[0].name) : directory;
}

async function walk(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(path, ...(await walk(path)));
  }
  return output;
}

type StackComponent = Readonly<{ name: string; directory: string; source: string | null; dependsOn: readonly string[] }>;
type StackDeployment = Readonly<{ name: string; destroy: boolean }>;
type PreparedDeployment = Readonly<{ name: string; destroy: boolean; components: readonly StoredComponent[]; archivePath: string }>;
type StackExecutionResult = Readonly<{ hasChanges: boolean; deferredChanges: boolean; output: string; statePath: string | null }>;

async function hasTerraformFiles(directory: string): Promise<boolean> {
  return (await readdir(directory, { withFileTypes: true })).some((entry) => entry.isFile() && (entry.name.endsWith(".tf") || entry.name.endsWith(".tf.json")));
}

function componentFromBlock(root: string, directory: string, block: readonly string[]): StackComponent | undefined {
  const name = block[1];
  if (typeof name !== "string") return undefined;
  const body = block[2] ?? "";
  const sourceMatch = /\bsource\s*=\s*"([^"]+)"/.exec(body);
  const source = sourceMatch?.[1] ?? null;
  const dependencyMatch = /\bdepends[_-]on\s*=\s*\[([^\]]*)\]/.exec(body);
  const dependsOn = dependencyMatch === null
    ? []
    : [...(dependencyMatch[1] ?? "").matchAll(/"([^"]+)"|\bcomponent\.([A-Za-z0-9_-]+)/g)].flatMap((match): string[] => {
        const dependency = match[1] ?? match[2];
        return typeof dependency === "string" ? [dependency.replace(/^component\./, "")] : [];
      });
  const candidate = source !== null && source.startsWith(".") ? resolve(directory, source) : directory;
  const relativeCandidate = relative(root, candidate);
  const insideRoot = relativeCandidate === "" || (!relativeCandidate.startsWith("..") && !relativeCandidate.startsWith("/"));
  return { name, directory: insideRoot ? candidate : directory, source, dependsOn };
}

async function componentsFromFile(
  root: string,
  directory: string,
  componentFile: Readonly<{ name: string }>,
  terraformFiles: boolean,
): Promise<readonly StackComponent[]> {
  const content = await readFile(join(directory, componentFile.name), "utf8");
  const blocks = [...content.matchAll(/\bcomponent\s+"([^"]+)"\s*\{([\s\S]*?)(?=\n\s*component\s+"|$)/g)];
  const components = blocks.flatMap((block): StackComponent[] => {
    const component = componentFromBlock(root, directory, block);
    return component === undefined ? [] : [component];
  });
  if (blocks.length === 0 && terraformFiles) {
    return [{ name: componentFile.name.replace(/\.tfcomponent\.hcl$/, ""), directory, source: null, dependsOn: [] }];
  }
  return components;
}

async function componentsInDirectory(root: string, directory: string): Promise<readonly StackComponent[]> {
  const files = await readdir(directory, { withFileTypes: true });
  const componentFiles = files.filter((entry) => entry.isFile() && entry.name.endsWith(".tfcomponent.hcl"));
  const terraformFiles = files.some((entry) => entry.isFile() && (entry.name.endsWith(".tf") || entry.name.endsWith(".tf.json")));
  if (componentFiles.length === 0 && !terraformFiles) return [];
  const components: StackComponent[] = [];
  for (const componentFile of componentFiles) {
    components.push(...await componentsFromFile(root, directory, componentFile, terraformFiles));
  }
  if (componentFiles.length === 0) {
    components.push({ name: directory === root ? "root" : directory.slice(root.length + 1), directory, source: null, dependsOn: [] });
  }
  return components;
}

async function componentDirectories(root: string): Promise<readonly StackComponent[]> {
  const directories = [root, ...(await walk(root))];
  const result: StackComponent[] = [];
  const seen = new Set<string>();
  const add = (component: StackComponent): void => {
    const key = `${component.name}|${component.directory}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(component);
  };
  for (const directory of directories) {
    for (const component of await componentsInDirectory(root, directory)) add(component);
  }
  return result.length === 0 ? [{ name: "root", directory: root, source: null, dependsOn: [] }] : result;
}

function orderComponents(components: readonly StackComponent[]): readonly StackComponent[] {
  const duplicate = components.find((component, index) => components.findIndex((other) => other.name === component.name) !== index);
  if (duplicate !== undefined) throw new Error(`Stack configuration declares component ${duplicate.name} more than once`);
  const byName = new Map(components.map((component) => [component.name, component]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: StackComponent[] = [];
  const visit = (name: string, owner = name): void => {
    const component = byName.get(name);
    if (component === undefined) throw new Error(`Component ${owner} depends on missing component ${name}`);
    if (visiting.has(name)) throw new Error(`Stack component dependency cycle includes ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of component.dependsOn) visit(dependency, name);
    visiting.delete(name);
    visited.add(name);
    ordered.push(component);
  };
  for (const component of components) visit(component.name);
  return ordered;
}

async function deploymentDefinitions(root: string): Promise<readonly StackDeployment[]> {
  const definitions = new Map<string, StackDeployment>();
  for (const directory of [root, ...(await walk(root))]) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".tfdeploy.hcl")) continue;
      const content = await readFile(join(directory, entry.name), "utf8");
      const blocks = [...content.matchAll(/\bdeployment\s+"([^"]+)"\s*\{([\s\S]*?)(?=\n\s*deployment\s+"|$)/g)];
      for (const block of blocks) {
        const name = block[1];
        if (typeof name === "string") definitions.set(name, { name, destroy: /\bdestroy\s*=\s*true\b/.test(block[2] ?? "") });
      }
    }
  }
  return definitions.size === 0 ? [{ name: "default", destroy: false }] : [...definitions.values()];
}

async function command(
  args: string[],
  cwd: string,
  sandbox: RunSandbox | null,
  heartbeat?: () => Promise<boolean>,
): Promise<Readonly<{ code: number; output: string; heartbeatLost: boolean }>> {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: "C" };
  const child = sandbox === null
    ? spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" })
    : sandbox.spawn(args, { cwd, env });
  let heartbeatLost = false;
  const interval = heartbeat === undefined ? undefined : setInterval((): void => {
    void heartbeat().then((owned): void => {
      if (!owned) {
        heartbeatLost = true;
        child.kill();
      }
    }).catch((): void => { heartbeatLost = true; child.kill(); });
  }, 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n"), heartbeatLost };
  } finally {
    if (interval !== undefined) clearInterval(interval);
  }
}

function stateFilePath(stackId: string, deployment: string): string {
  const safe = `${stackId}-${deployment}`.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const digest = createHash("sha256").update(`${stackId}\0${deployment}`).digest("hex").slice(0, 12);
  return join(STACK_STORAGE_DIR, "states", `${safe}-${digest}.tfstate`);
}

function planHasChanges(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const changes = parsed.resource_changes;
    return Array.isArray(changes) && changes.some((item): boolean => {
      if (item === null || typeof item !== "object") return false;
      const actions = (item as Record<string, unknown>).change;
      if (actions === null || typeof actions !== "object") return false;
      const raw = (actions as Record<string, unknown>).actions;
      return Array.isArray(raw) && raw.some((action): boolean => action !== "no-op");
    });
  } catch {
    return false;
  }
}

export async function saveStackState(stackId: string, deployment: string, runId: string, statePayload: string | null = null, fencingToken?: number): Promise<string> {
  const path = stateFilePath(stackId, deployment);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (fencingToken !== undefined && !await refreshStackStateLock(stackId, deployment, runId, fencingToken)) throw new Error("Stack state lock ownership was lost before state publication");
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  let temporaryState = false;
  if (statePayload !== null) {
    try {
      JSON.parse(statePayload);
      await writeFile(temporary, statePayload, { mode: 0o600 });
      temporaryState = true;
    } catch {
      statePayload = null;
      await rm(temporary, { force: true });
    }
  }
  if (!temporaryState && !(await Bun.file(path).exists())) {
    await writeFile(temporary, JSON.stringify({ version: 4, terraform_version: "", serial: 0, lineage: crypto.randomUUID(), outputs: {}, resources: [] }), { mode: 0o600 });
    temporaryState = true;
  }
  if (temporaryState) {
    if (fencingToken !== undefined && !await refreshStackStateLock(stackId, deployment, runId, fencingToken)) {
      await rm(temporary, { force: true });
      throw new Error("Stack state lock ownership was lost before state publication");
    }
    await rename(temporary, path);
  }
  const existing = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, stackId), eq(stackRecords.recordType, "stack-states")) });
  if (fencingToken !== undefined && !await refreshStackStateLock(stackId, deployment, runId, fencingToken)) throw new Error("Stack state lock ownership was lost during state publication");
  for (const record of existing.filter((candidate) => candidate.name === deployment)) {
    await db.update(stackRecords).set({ payload: { ...(record.payload ?? {}), "is-current": false }, updatedAt: Date.now() }).where(eq(stackRecords.id, record.id));
  }
  await db.insert(stackRecords).values({
    id: `sst-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    stackId,
    parentId: runId,
    recordType: "stack-states",
    name: deployment,
    status: "current",
    payload: { generation: existing.filter((record) => record.name === deployment).length + 1, "is-current": true, runId, descriptionPath: path, components: [] },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return path;
}

export async function removeStackState(stackId: string, deployment: string, runId: string, fencingToken?: number): Promise<void> {
  if (fencingToken !== undefined && !await refreshStackStateLock(stackId, deployment, runId, fencingToken)) throw new Error("Stack state lock ownership was lost before state removal");
  await rm(stateFilePath(stackId, deployment), { force: true });
  const records = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, stackId), eq(stackRecords.recordType, "stack-states"), eq(stackRecords.name, deployment)) });
  for (const record of records) await db.update(stackRecords).set({ status: "destroyed", payload: { ...(record.payload ?? {}), "is-current": false }, updatedAt: Date.now() }).where(eq(stackRecords.id, record.id));
  if (fencingToken !== undefined && !await refreshStackStateLock(stackId, deployment, runId, fencingToken)) throw new Error("Stack state lock ownership was lost during state removal");
}

type TerraformCommandResult = Readonly<{ code: number; output: string; heartbeatLost: boolean }>;

type ComponentExecutionStart = Readonly<{
  executionDirectory: string;
  planPath: string;
  binaryPath: string;
  init: TerraformCommandResult;
  commandResult: TerraformCommandResult;
  heartbeat: () => Promise<boolean>;
}>;

async function simulatedComponentExecution(
  stackId: string,
  deployment: string,
  runId: string,
  operation: "plan" | "apply",
  destroy: boolean,
  fencingToken: number | null,
  statePath: string,
): Promise<StackExecutionResult> {
  const hasChanges = operation === "plan" && envEnabled(process.env.SIMULATED_STACK_PLAN_CHANGES);
  const deferredChanges = operation === "plan" && envEnabled(process.env.SIMULATED_STACK_DEFERRED);
  if (operation === "apply") {
    if (destroy) await removeStackState(stackId, deployment, runId, fencingToken ?? undefined);
    else await saveStackState(stackId, deployment, runId, null, fencingToken ?? undefined);
  }
  return { hasChanges, deferredChanges, output: hasChanges ? "Plan: changes present" : "No changes. Your infrastructure matches the configuration.", statePath: operation === "apply" ? statePath : null };
}

function componentSandbox(): RunSandbox | null {
  const required = runSandboxRequired();
  const sandbox = required ? (RunSandbox.isUsable() ? new RunSandbox() : null) : null;
  if (required && sandbox === null) throw new Error("Stack execution requires an available Landlock sandbox");
  return sandbox;
}

async function runTerraformComponentOperation(
  operation: "plan" | "apply",
  planArgs: string[],
  planArtifactPath: string | null,
  executionDirectory: string,
  workDirectory: string,
  sandbox: RunSandbox | null,
  heartbeat: () => Promise<boolean>,
  binaryPath: string,
): Promise<TerraformCommandResult> {
  if (operation === "plan") return command(planArgs, executionDirectory, sandbox, heartbeat);
  if (planArtifactPath === null || !(await Bun.file(planArtifactPath).exists())) throw new Error("The approved Stack plan artifact is unavailable");
  const planPath = join(workDirectory, "tfplan");
  await copyFile(planArtifactPath, planPath);
  return command([binaryPath, "apply", "-no-color", "-input=false", planPath], executionDirectory, sandbox, heartbeat);
}

type ComponentExecutionRequest = Readonly<{
  component: StackComponent;
  stepId: string;
  runId: string;
  stackId: string;
  deployment: string;
  operation: "plan" | "apply";
  planArtifactPath: string | null;
  destroy: boolean;
  fencingToken: number | null;
  context: DurableJobContext;
  workDirectory: string;
  sandbox: RunSandbox | null;
  statePath: string;
}>;

async function startTerraformComponentExecution(request: ComponentExecutionRequest): Promise<ComponentExecutionStart | StackExecutionResult> {
  const {
    component,
    runId,
    stackId,
    deployment,
    operation,
    planArtifactPath,
    destroy,
    fencingToken,
    context,
    workDirectory,
    sandbox,
    statePath,
  } = request;
  const executionDirectory = join(workDirectory, "source");
  await cp(component.directory, executionDirectory, { recursive: true });
  await mkdir(STACK_STORAGE_DIR, { recursive: true, mode: 0o700 });
  await writeFile(join(executionDirectory, "terrence_backend_override.tf"), 'terraform { backend "local" {} }\n', { mode: 0o600 });
  const requestedTool = process.env.TERRENCE_STACK_IAC_BINARY ?? "terraform";
  const requestedVersion = process.env.TERRENCE_STACK_IAC_VERSION ?? "latest";
  const resolved = await ensureBinary(requestedTool, requestedVersion);
  if (resolved === null) throw new Error(`Unable to resolve ${requestedTool} ${requestedVersion}`);
  const heartbeat = async (): Promise<boolean> => {
    if (!await context.heartbeat()) return false;
    return fencingToken === null || await refreshStackStateLock(stackId, deployment, runId, fencingToken);
  };
  const init = await command([resolved.binaryPath, "init", "-backend=false", "-no-color", "-input=false"], executionDirectory, sandbox, heartbeat);
  if (init.heartbeatLost || !await heartbeat()) throw new Error(`Stack ${operation} lost its execution lease during initialization`);
  const planPath = join(workDirectory, "tfplan");
  const stateExists = await Bun.file(statePath).exists();
  if (stateExists) await copyFile(statePath, join(executionDirectory, "terraform.tfstate"));
  const planArgs = [resolved.binaryPath, "plan", "-detailed-exitcode", "-no-color", "-input=false", ...(destroy ? ["-destroy"] : []), "-out", planPath];
  if (stateExists) planArgs.push("-state", statePath, "-state-out", `${statePath}.next`);
  const commandResult = await runTerraformComponentOperation(operation, planArgs, planArtifactPath, executionDirectory, workDirectory, sandbox, heartbeat, resolved.binaryPath);
  if (await context.canceled()) return { hasChanges: false, deferredChanges: false, output: "", statePath: null };
  if (commandResult.heartbeatLost || !await heartbeat()) throw new Error(`Stack ${operation} lost its execution lease`);
  return { executionDirectory, planPath, binaryPath: resolved.binaryPath, init, commandResult, heartbeat };
}

async function persistTerraformComponentArtifacts(
  start: ComponentExecutionStart,
  stepId: string,
  stackId: string,
  operation: "plan" | "apply",
): Promise<void> {
  const { planPath, init, commandResult } = start;
  const descriptionPath = join(STACK_STORAGE_DIR, `${stepId}-${operation}.txt`);
  const logPath = join(STACK_STORAGE_DIR, `${stepId}-${operation}.log`);
  await writeFile(descriptionPath, commandResult.output || init.output, { mode: 0o600 });
  await writeFile(logPath, [`init (${init.code})`, init.output, `${operation} (${commandResult.code})`, commandResult.output].filter(Boolean).join("\n"), { mode: 0o600 });
  if (operation === "plan" && (commandResult.code === 0 || commandResult.code === 2) && await Bun.file(planPath).exists()) await copyFile(planPath, join(STACK_STORAGE_DIR, `${stepId}-plan`));
  const now = Date.now();
  await db.insert(stackRecords).values([
    { id: `sart-${crypto.randomUUID()}`, stackId, parentId: stepId, recordType: "stack-artifacts", name: `${operation}-description`, status: "ready", payload: { path: descriptionPath }, createdAt: now, updatedAt: now },
    { id: `sart-${crypto.randomUUID()}`, stackId, parentId: stepId, recordType: "stack-artifacts", name: `${operation}-debug-log`, status: "ready", payload: { path: logPath }, createdAt: now, updatedAt: now },
  ]);
}

async function finalizeTerraformComponentState(
  start: ComponentExecutionStart,
  request: ComponentExecutionRequest,
): Promise<string> {
  const { operation, destroy, stackId, deployment, runId, fencingToken, sandbox } = request;
  const { executionDirectory, planPath, binaryPath, init, commandResult, heartbeat } = start;
  if (init.code !== 0 || (operation === "plan" ? ![0, 2].includes(commandResult.code) : commandResult.code !== 0)) throw new Error(commandResult.output || init.output || `Terraform ${operation} failed`);
  if (operation === "plan") {
    const json = await command([binaryPath, "show", "-json", planPath], executionDirectory, sandbox, heartbeat);
    if (json.heartbeatLost || !await heartbeat()) throw new Error("Stack plan lost its execution lease while collecting output");
    return json.code === 0 ? json.output : "";
  }
  const generatedState = join(executionDirectory, "terraform.tfstate");
  const generatedStatePayload = await Bun.file(generatedState).exists() ? await readFile(generatedState, "utf8") : null;
  if (destroy) await removeStackState(stackId, deployment, runId, fencingToken ?? undefined);
  else await saveStackState(stackId, deployment, runId, generatedStatePayload, fencingToken ?? undefined);
  return "";
}

async function finalizeTerraformComponentExecution(
  start: ComponentExecutionStart,
  request: ComponentExecutionRequest,
): Promise<StackExecutionResult> {
  const { stepId, stackId, operation } = request;
  await persistTerraformComponentArtifacts(start, stepId, stackId, operation);
  const show = await finalizeTerraformComponentState(start, request);
  return { hasChanges: operation === "plan" && (start.commandResult.code === 2 || planHasChanges(show)), deferredChanges: operation === "plan" && /\bdeferred\b/i.test(start.commandResult.output), output: start.commandResult.output || start.init.output, statePath: operation === "apply" ? request.statePath : null };
}

async function executeRealTerraformComponent(request: ComponentExecutionRequest): Promise<StackExecutionResult> {
  const start = await startTerraformComponentExecution(request);
  if ("hasChanges" in start) return start;
  return finalizeTerraformComponentExecution(start, request);
}

async function executeComponent(
  component: StackComponent,
  stepId: string,
  runId: string,
  stackId: string,
  deployment: string,
  operation: "plan" | "apply",
  planArtifactPath: string | null,
  destroy: boolean,
  fencingToken: number | null,
  context: DurableJobContext,
): Promise<StackExecutionResult> {
  const statePath = stateFilePath(stackId, deployment);
  if (envEnabled(process.env.SIMULATED_RUNS) || process.env.NODE_ENV === "test") {
    return simulatedComponentExecution(stackId, deployment, runId, operation, destroy, fencingToken, statePath);
  }
  if (!(await hasTerraformFiles(component.directory))) {
    throw new Error(component.source === null
      ? `Component ${component.name} has no Terraform configuration files`
      : `Component ${component.name} source ${component.source} is not a local Terraform module; Stack execution requires a remote or agent worker`);
  }
  const sandbox = componentSandbox();
  const workDirectory = sandbox === null
    ? await mkdtemp(join(tmpdir(), "terrence-stack-run-"))
    : await sandbox.prepareWorkDir(stepId);
  try {
    return await executeRealTerraformComponent({
      component,
      stepId,
      runId,
      stackId,
      deployment,
      operation,
      planArtifactPath,
      destroy,
      fencingToken,
      context,
      workDirectory,
      sandbox,
      statePath,
    });
  } finally {
    await rm(`${statePath}.next`, { force: true });
    if (sandbox === null) await rm(workDirectory, { recursive: true, force: true });
    else await removeSandboxWorkDir(stepId);
  }
}

type StoredComponent = Readonly<{ name: string; directory: string; source: string | null; dependsOn: readonly string[] }>;

function storedComponents(value: unknown): readonly StoredComponent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): StoredComponent[] => {
    if (item === null || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    return typeof row.name === "string" && typeof row.directory === "string"
      ? [{ name: row.name, directory: row.directory, source: typeof row.source === "string" ? row.source : null, dependsOn: Array.isArray(row.dependsOn) ? row.dependsOn.filter((entry): entry is string => typeof entry === "string") : [] }]
      : [];
  });
}

function payloadString(record: Readonly<typeof stackRecords.$inferSelect>, key: string): string | undefined {
  const value = (record.payload ?? {})[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function payloadNumber(record: Readonly<typeof stackRecords.$inferSelect>, key: string, fallback: number): number {
  const value = (record.payload ?? {})[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function payloadFencingToken(record: Readonly<typeof stackRecords.$inferSelect>): number | undefined {
  const value = (record.payload ?? {})["fencing-token"] ?? (record.payload ?? {}).fencingToken;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export async function refreshStackStateLock(stackId: string, deployment: string, runId: string, fencingToken?: number): Promise<boolean> {
  const now = Date.now();
  const updated = await db.update(stackStateLocks).set({ leaseExpiresAt: now + STACK_STATE_LOCK_LEASE_MS, updatedAt: now }).where(and(
    eq(stackStateLocks.stackId, stackId),
    eq(stackStateLocks.deployment, deployment),
    eq(stackStateLocks.runId, runId),
    gt(stackStateLocks.leaseExpiresAt, now),
    ...(fencingToken === undefined ? [] : [eq(stackStateLocks.fencingToken, fencingToken)]),
  )).returning({ id: stackStateLocks.id });
  return updated.length > 0;
}

async function acquireStackStateLock(stackId: string, deployment: string, runId: string): Promise<number | null> {
  const now = Date.now();
  const id = `ssl-${crypto.randomUUID()}`;
  await db.insert(stackStateLocks).values({ id, stackId, deployment, runId: null, fencingToken: 0, acquiredAt: null, leaseExpiresAt: null, releasedAt: now, updatedAt: now }).onConflictDoNothing({ target: [stackStateLocks.stackId, stackStateLocks.deployment] });
  const current = await db.query.stackStateLocks.findFirst({ where: and(eq(stackStateLocks.stackId, stackId), eq(stackStateLocks.deployment, deployment), eq(stackStateLocks.runId, runId)) });
  if (current !== undefined && current.leaseExpiresAt !== null && current.leaseExpiresAt > now && await refreshStackStateLock(stackId, deployment, runId, current.fencingToken)) return current.fencingToken;
  const claimed = await db.update(stackStateLocks).set({ runId, acquiredAt: now, leaseExpiresAt: now + STACK_STATE_LOCK_LEASE_MS, releasedAt: null, fencingToken: sql`${stackStateLocks.fencingToken} + 1`, updatedAt: now }).where(and(
    eq(stackStateLocks.stackId, stackId),
    eq(stackStateLocks.deployment, deployment),
    or(isNull(stackStateLocks.runId), isNull(stackStateLocks.leaseExpiresAt), lt(stackStateLocks.leaseExpiresAt, now)),
  )).returning({ fencingToken: stackStateLocks.fencingToken });
  return claimed[0]?.fencingToken ?? null;
}

async function releaseStackStateLock(stackId: string, deployment: string, runId: string, fencingToken?: number): Promise<void> {
  await db.update(stackStateLocks).set({ runId: null, leaseExpiresAt: null, releasedAt: Date.now(), updatedAt: Date.now() }).where(and(
    eq(stackStateLocks.stackId, stackId),
    eq(stackStateLocks.deployment, deployment),
    eq(stackStateLocks.runId, runId),
    ...(fencingToken === undefined ? [] : [eq(stackStateLocks.fencingToken, fencingToken)]),
  ));
}

async function createDeploymentStep(stackId: string, runId: string, component: StoredComponent, index: number, phase: "plan" | "apply" | "convergence", requiresStateLock: boolean, fencingToken?: number): Promise<Readonly<typeof stackRecords.$inferSelect>> {
  const step: typeof stackRecords.$inferInsert = {
    id: `sds-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    stackId,
    parentId: runId,
    recordType: "stack-deployment-steps",
    name: component.name,
    status: "queued",
    payload: { "operation-type": "plan", phase, componentIndex: index, "requires-state-lock": requiresStateLock, ...(fencingToken === undefined ? {} : { "fencing-token": fencingToken }), "deferred-changes": false, "has-changes": false },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (phase === "apply") step.payload = { ...(step.payload ?? {}), "operation-type": "apply" };
  const inserted = await db.insert(stackRecords).values(step).returning();
  const created = inserted[0];
  if (created === undefined) throw new Error("Stack deployment step could not be created");
  return created;
}

async function queueStackAgentStep(stack: Stack, runId: string, step: typeof stackRecords.$inferSelect, phase: "plan" | "apply"): Promise<void> {
  if (stack.agentPoolId === null) throw new Error("Agent execution requires an agent pool");
  const existing = await db.query.stackAgentJobs.findFirst({ where: and(eq(stackAgentJobs.stepId, step.id), eq(stackAgentJobs.phase, phase)) });
  if (existing !== undefined && ["queued", "claimed"].includes(existing.status)) return;
  if (existing !== undefined) {
    await db.update(stackAgentJobs).set({ status: "queued", agentId: null, result: null, errorMessage: null, claimedAt: null, completedAt: null, updatedAt: Date.now() }).where(and(eq(stackAgentJobs.id, existing.id), inArray(stackAgentJobs.status, ["completed", "errored", "canceled"])));
    return;
  }
  await db.insert(stackAgentJobs).values({ id: `saj-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`, stackId: stack.id, deploymentRunId: runId, stepId: step.id, agentPoolId: stack.agentPoolId, agentId: null, phase, iacBinary: process.env.TERRENCE_STACK_IAC_BINARY ?? "terraform", status: "queued", result: null, errorMessage: null, claimedAt: null, completedAt: null, createdAt: Date.now(), updatedAt: Date.now() }).onConflictDoNothing({ target: [stackAgentJobs.stepId, stackAgentJobs.phase] });
}

async function scheduleStackRun(runId: string, delay = 0): Promise<void> {
  await enqueueDurableJob("stack-deployment", { runId }, { dedupeKey: `stack-run:${runId}`, runAfter: Date.now() + delay, rescheduleRunning: true });
}

async function failStackRun(stack: Stack, run: Readonly<typeof stackRecords.$inferSelect>, step: Readonly<typeof stackRecords.$inferSelect> | undefined, detail: string, fencingToken?: number): Promise<void> {
  const now = Date.now();
  if (step !== undefined) await db.update(stackRecords).set({ status: "failed", payload: { ...(step.payload ?? {}), error: detail }, updatedAt: now }).where(eq(stackRecords.id, step.id));
  await db.update(stackRecords).set({ status: "failed", payload: { ...(run.payload ?? {}), error: detail }, updatedAt: now }).where(eq(stackRecords.id, run.id));
  if (run.parentId !== null) await db.update(stackRecords).set({ status: "failed", updatedAt: now }).where(eq(stackRecords.id, run.parentId));
  await releaseStackStateLock(stack.id, run.name ?? "default", run.id, fencingToken ?? payloadFencingToken(step ?? run) ?? payloadFencingToken(run));
}

async function recoverAgentApplyState(stack: Stack, run: Readonly<typeof stackRecords.$inferSelect>, step: Readonly<typeof stackRecords.$inferSelect>): Promise<void> {
  const deployment = run.name ?? "default";
  const current = await db.query.stackRecords.findFirst({ where: and(
    eq(stackRecords.stackId, stack.id),
    eq(stackRecords.recordType, "stack-states"),
    eq(stackRecords.name, deployment),
    eq(stackRecords.status, "current"),
  ) });
  if (current !== undefined) return;
  const state = (step.payload ?? {}).state ?? (step.payload ?? {}).json_state;
  const statePayload = typeof state === "string" ? state : state !== null && typeof state === "object" ? JSON.stringify(state) : null;
  const fencingToken = payloadFencingToken(step) ?? payloadFencingToken(run);
  if (run.payload?.destroy === true) {
    await removeStackState(stack.id, deployment, run.id, fencingToken);
    return;
  }
  if (statePayload === null) throw new Error("Completed Stack agent apply has no resulting state to recover");
  await saveStackState(stack.id, deployment, run.id, statePayload, fencingToken);
}

type StackDeploymentInputs = Readonly<{
  run: Readonly<typeof stackRecords.$inferSelect>;
  stack: Stack;
  configuration: Readonly<typeof stackRecords.$inferSelect>;
  runPayload: Record<string, unknown>;
  components: readonly StoredComponent[];
  index: number;
  component: StoredComponent;
}>;

type StackDeploymentStepDecision =
  | Readonly<{ handled: true }>
  | Readonly<{ handled: false; step: Readonly<typeof stackRecords.$inferSelect> }>;

async function completeStackDeploymentRun(
  stack: Stack,
  run: Readonly<typeof stackRecords.$inferSelect>,
): Promise<void> {
  await db.update(stackRecords).set({ status: "succeeded", updatedAt: Date.now() }).where(eq(stackRecords.id, run.id));
  if (run.parentId !== null) {
    const parent = await db.query.stackRecords.findFirst({ where: eq(stackRecords.id, run.parentId) });
    await db.update(stackRecords).set({ status: "succeeded", payload: { ...parent?.payload, latestRunId: run.id }, updatedAt: Date.now() }).where(eq(stackRecords.id, run.parentId));
  }
  await releaseStackStateLock(stack.id, run.name ?? "default", run.id, payloadFencingToken(run));
}

async function loadStackDeploymentInputs(
  job: Job,
  context: DurableJobContext,
): Promise<StackDeploymentInputs | undefined> {
  const runId = typeof job.payload.runId === "string" ? job.payload.runId : "";
  if (runId === "") throw new Error("stack-deployment job is missing runId");
  const run = await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, runId), eq(stackRecords.recordType, "stack-deployment-runs")) });
  if (run === undefined || ["succeeded", "failed", "canceled"].includes(run.status) || await context.canceled()) return undefined;
  const stack = await db.query.stacks.findFirst({ where: eq(stacks.id, run.stackId) });
  const configurationId = payloadString(run, "configurationId");
  const configuration = configurationId === undefined ? undefined : await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, configurationId), eq(stackRecords.recordType, "stack-configurations")) });
  if (stack === undefined || configuration === undefined) {
    if (stack !== undefined) await failStackRun(stack, run, undefined, "Stack configuration is unavailable");
    return undefined;
  }
  const runPayload = run.payload ?? {};
  const configuredComponents = storedComponents((configuration.payload ?? {}).components);
  const runComponents = storedComponents(runPayload.components);
  const components = runComponents.length > 0 ? runComponents : configuredComponents;
  const index = payloadNumber(run, "componentIndex", 0);
  const component = components[index];
  if (component === undefined) {
    await completeStackDeploymentRun(stack, run);
    return undefined;
  }
  return { run, stack, configuration, runPayload, components, index, component };
}

async function handleTerminalStackDeploymentStep(
  stack: Stack,
  run: Readonly<typeof stackRecords.$inferSelect>,
  step: Readonly<typeof stackRecords.$inferSelect>,
): Promise<StackDeploymentStepDecision> {
  if (!["failed", "canceled"].includes(step.status)) return { handled: false, step };
  await db.update(stackRecords).set({ status: step.status, updatedAt: Date.now() }).where(eq(stackRecords.id, run.id));
  await releaseStackStateLock(stack.id, run.name ?? "default", run.id, payloadFencingToken(step) ?? payloadFencingToken(run));
  return { handled: true };
}

async function handlePendingOperatorStackStep(
  inputs: StackDeploymentInputs,
): Promise<StackDeploymentStepDecision> {
  const { run, stack, component, index } = inputs;
  if (run.status !== "approved") return { handled: true };
  const fencingToken = await acquireStackStateLock(stack.id, run.name ?? "default", run.id);
  if (fencingToken === null) {
    await scheduleStackRun(run.id, 1000);
    return { handled: true };
  }
  const apply = await createDeploymentStep(stack.id, run.id, component, index, "apply", true, fencingToken);
  await db.update(stackRecords).set({ status: "applying", payload: { ...(run.payload ?? {}), lockAcquired: true, fencingToken }, updatedAt: Date.now() }).where(eq(stackRecords.id, run.id));
  return { handled: false, step: apply };
}

async function handleCompletedApplyStackStep(
  inputs: StackDeploymentInputs,
  step: Readonly<typeof stackRecords.$inferSelect>,
): Promise<StackDeploymentStepDecision> {
  const { run, stack, component, index } = inputs;
  if (stack.executionMode === "agent") await recoverAgentApplyState(stack, run, step);
  const cycle = payloadNumber(run, "cycle", 0) + 1;
  if (cycle > 10) {
    await failStackRun(stack, run, step, "Stack deployment did not converge after 10 apply cycles");
    return { handled: true };
  }
  const fencingToken = await acquireStackStateLock(stack.id, run.name ?? "default", run.id);
  if (fencingToken === null) {
    await scheduleStackRun(run.id, 1000);
    return { handled: true };
  }
  const convergence = await createDeploymentStep(stack.id, run.id, component, index, "convergence", true, fencingToken);
  await db.update(stackRecords).set({ status: "planning", payload: { ...(run.payload ?? {}), cycle, fencingToken }, updatedAt: Date.now() }).where(eq(stackRecords.id, run.id));
  return { handled: false, step: convergence };
}

async function handleCompletedPlanChanges(
  inputs: StackDeploymentInputs,
): Promise<StackDeploymentStepDecision> {
  const { run, stack, component, index } = inputs;
  if (run.status !== "approved") return { handled: true };
  const apply = await createDeploymentStep(stack.id, run.id, component, index, "apply", true);
  await db.update(stackRecords).set({ status: "applying", updatedAt: Date.now() }).where(eq(stackRecords.id, run.id));
  return { handled: false, step: apply };
}

async function handleCompletedPlanWithoutChanges(
  inputs: StackDeploymentInputs,
): Promise<StackDeploymentStepDecision> {
  const { run, stack, components, index } = inputs;
  const nextIndex = index + 1;
  if (nextIndex >= components.length) {
    await completeStackDeploymentRun(stack, run);
    return { handled: true };
  }
  const nextComponent = components[nextIndex];
  if (nextComponent === undefined) return { handled: true };
  await createDeploymentStep(stack.id, run.id, nextComponent, nextIndex, "plan", false);
  await db.update(stackRecords).set({ status: "planning", payload: { ...(run.payload ?? {}), component: nextComponent.name, componentIndex: nextIndex, cycle: 0 }, updatedAt: Date.now() }).where(eq(stackRecords.id, run.id));
  await scheduleStackRun(run.id);
  return { handled: true };
}

async function handleCompletedStackDeploymentStep(
  inputs: StackDeploymentInputs,
  step: Readonly<typeof stackRecords.$inferSelect>,
  phase: string,
): Promise<StackDeploymentStepDecision> {
  const stepPayload = step.payload ?? {};
  const hasChanges = stepPayload["has-changes"] === true || stepPayload.hasChanges === true;
  const deferred = stepPayload["deferred-changes"] === true || stepPayload.deferredChanges === true;
  if (phase === "apply") return handleCompletedApplyStackStep(inputs, step);
  if (hasChanges || deferred) return handleCompletedPlanChanges(inputs);
  return handleCompletedPlanWithoutChanges(inputs);
}

async function advanceStackDeploymentStep(
  inputs: StackDeploymentInputs,
  existingStep: Readonly<typeof stackRecords.$inferSelect> | undefined,
): Promise<StackDeploymentStepDecision> {
  const { run, stack, component, index } = inputs;
  const phase = existingStep === undefined
    ? "plan"
    : payloadString(existingStep, "phase") ?? (payloadString(existingStep, "operation-type") === "apply" ? "apply" : "plan");
  if (existingStep !== undefined && ["failed", "canceled"].includes(existingStep.status)) {
    return handleTerminalStackDeploymentStep(stack, run, existingStep);
  }
  if (existingStep?.status === "pending_operator") return handlePendingOperatorStackStep(inputs);
  if (existingStep?.status === "completed") return handleCompletedStackDeploymentStep(inputs, existingStep, phase);
  if (existingStep === undefined) {
    const plan = await createDeploymentStep(stack.id, run.id, component, index, "plan", false);
    await db.update(stackRecords).set({ status: "planning", updatedAt: Date.now() }).where(eq(stackRecords.id, run.id));
    return { handled: false, step: plan };
  }
  return { handled: false, step: existingStep };
}

async function planArtifactPathForStackStep(
  run: Readonly<typeof stackRecords.$inferSelect>,
  component: StoredComponent,
  step: Readonly<typeof stackRecords.$inferSelect>,
  operation: "plan" | "apply",
): Promise<string | null> {
  if (operation !== "apply") return null;
  const planPayload = (await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, run.id), eq(stackRecords.recordType, "stack-deployment-steps"), eq(stackRecords.name, component.name)), orderBy: [desc(stackRecords.createdAt)] }))
    .find((candidate) => ["plan", "convergence"].includes(payloadString(candidate, "phase") ?? "") && candidate.id !== step.id);
  return planPayload === undefined ? null : join(STACK_STORAGE_DIR, `${planPayload.id}-plan`);
}

function stackDeploymentArchivePath(
  run: Readonly<typeof stackRecords.$inferSelect>,
  configuration: Readonly<typeof stackRecords.$inferSelect>,
): string {
  const runArchivePath = (run.payload ?? {}).archivePath;
  if (typeof runArchivePath === "string") return runArchivePath;
  const configurationArchivePath = (configuration.payload ?? {}).archivePath;
  return typeof configurationArchivePath === "string" ? configurationArchivePath : "";
}

async function executeStackComponentFromArchive(
  archivePath: string,
  component: StoredComponent,
  step: Readonly<typeof stackRecords.$inferSelect>,
  run: Readonly<typeof stackRecords.$inferSelect>,
  stack: Stack,
  configuration: Readonly<typeof stackRecords.$inferSelect>,
  operation: "plan" | "apply",
  planArtifactPath: string | null,
  fencingToken: number | null,
  context: DurableJobContext,
): Promise<StackExecutionResult> {
  const staging = await mkdtemp(join(tmpdir(), "terrence-stack-step-"));
  try {
    await validateModuleArchive(archivePath);
    await extractValidatedModuleArchive(archivePath, staging);
    const root = await findArchiveRoot(staging);
    const directory = resolve(root, component.directory);
    const relativeDirectory = relative(root, directory);
    const insideRoot = relativeDirectory === "" || (!relativeDirectory.startsWith("..") && !relativeDirectory.startsWith("/"));
    if (!insideRoot) throw new Error(`Component ${component.name} is outside the Stack configuration archive`);
    const destroy = (run.payload ?? {}).destroy === true || (configuration.payload ?? {})["destroy-all"] === true;
    return await executeComponent({ ...component, directory }, step.id, run.id, stack.id, run.name ?? "default", operation, planArtifactPath, destroy, fencingToken, context);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function persistStackExecutionResult(
  run: Readonly<typeof stackRecords.$inferSelect>,
  step: Readonly<typeof stackRecords.$inferSelect>,
  operation: "plan" | "apply",
  result: StackExecutionResult,
): Promise<void> {
  await db.update(stackRecords).set({ status: result.hasChanges || result.deferredChanges ? "pending_operator" : "completed", payload: { ...(step.payload ?? {}), hasChanges: result.hasChanges, "has-changes": result.hasChanges, deferredChanges: result.deferredChanges, "deferred-changes": result.deferredChanges, output: result.output }, updatedAt: Date.now() }).where(eq(stackRecords.id, step.id));
  if (operation === "plan" && (result.hasChanges || result.deferredChanges)) {
    await db.update(stackRecords).set({ status: "pre_deploying_pending_operator", updatedAt: Date.now() }).where(eq(stackRecords.id, run.id));
  } else {
    await db.update(stackRecords).set({ status: "step_completed", updatedAt: Date.now() }).where(eq(stackRecords.id, run.id));
    await scheduleStackRun(run.id);
  }
}

type StackStepExecutionPreparation = Readonly<{ ready: boolean; fencingToken: number | null }>;

async function prepareStackStepExecution(
  run: Readonly<typeof stackRecords.$inferSelect>,
  step: Readonly<typeof stackRecords.$inferSelect>,
  stack: Stack,
  operation: "plan" | "apply",
): Promise<StackStepExecutionPreparation> {
  let fencingToken: number | null = null;
  if (operation === "apply" || (step.payload ?? {})["requires-state-lock"] === true) {
    fencingToken = await acquireStackStateLock(stack.id, run.name ?? "default", run.id);
    if (fencingToken === null) {
      await scheduleStackRun(run.id, 1000);
      return { ready: false, fencingToken: null };
    }
    await db.update(stackRecords).set({ payload: { ...(step.payload ?? {}), "fencing-token": fencingToken }, updatedAt: Date.now() }).where(eq(stackRecords.id, step.id));
  }
  await db.update(stackRecords).set({ status: "running", updatedAt: Date.now() }).where(eq(stackRecords.id, step.id));
  await db.update(stackRecords).set({ status: operation === "apply" ? "applying" : "planning", updatedAt: Date.now() }).where(eq(stackRecords.id, run.id));
  return { ready: true, fencingToken };
}

async function executeStackDeploymentStep(
  inputs: StackDeploymentInputs,
  step: Readonly<typeof stackRecords.$inferSelect>,
  operation: "plan" | "apply",
  context: DurableJobContext,
): Promise<void> {
  const { run, stack, configuration, component } = inputs;
  const preparation = await prepareStackStepExecution(run, step, stack, operation);
  if (!preparation.ready) return;
  try {
    const planArtifactPath = await planArtifactPathForStackStep(run, component, step, operation);
    if (stack.executionMode === "agent") {
      await queueStackAgentStep(stack, run.id, step, operation);
      await scheduleStackRun(run.id, 15_000);
      return;
    }
    const archivePath = stackDeploymentArchivePath(run, configuration);
    if (archivePath === "" || !(await Bun.file(archivePath).exists())) throw new Error("The Stack configuration archive is unavailable");
    const result = await executeStackComponentFromArchive(archivePath, component, step, run, stack, configuration, operation, planArtifactPath, preparation.fencingToken, context);
    if (await context.canceled()) return;
    await persistStackExecutionResult(run, step, operation, result);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    if (await context.canceled()) return;
    await failStackRun(stack, run, step, detail, preparation.fencingToken ?? undefined);
  }
}

export async function runStackDeploymentJob(job: Job, context: DurableJobContext): Promise<void> {
  const inputs = await loadStackDeploymentInputs(job, context);
  if (inputs === undefined) return;
  const steps = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.parentId, inputs.run.id), eq(stackRecords.recordType, "stack-deployment-steps")), orderBy: [desc(stackRecords.createdAt)] });
  const decision = await advanceStackDeploymentStep(inputs, steps[0]);
  if (decision.handled) return;
  const step = decision.step;
  const currentPhase = payloadString(step, "phase") ?? "plan";
  const operation: "plan" | "apply" = currentPhase === "apply" ? "apply" : "plan";
  if (step.status === "pending_operator" || step.status === "completed") return;
  await executeStackDeploymentStep(inputs, step, operation, context);
}

async function addDiagnostic(configId: string, stackId: string, detail: string): Promise<void> {
  await db.insert(stackRecords).values({ id: `sdiag-${crypto.randomUUID()}`, stackId, parentId: configId, recordType: "stack-diagnostics", name: null, status: "error", payload: { severity: "error", summary: "Stack configuration failed", detail }, createdAt: Date.now(), updatedAt: Date.now() });
}

type ComponentPayload = Readonly<{ name: string; directory: string; source: string | null; dependsOn: readonly string[] }>;

type PreparedStackConfiguration = Readonly<{
  componentPayload: readonly ComponentPayload[];
  preparedDeployments: readonly PreparedDeployment[];
}>;

function eligiblePreviousDeploymentName(
  group: Readonly<typeof stackRecords.$inferSelect>,
  currentNames: ReadonlySet<string>,
  seenPreviousNames: Set<string>,
): string | undefined {
  const name = group.name;
  if (name === null || currentNames.has(name) || seenPreviousNames.has(name) || group.status === "succeeded") return undefined;
  seenPreviousNames.add(name);
  return name;
}

function previousDeploymentArchive(configuration: Readonly<typeof stackRecords.$inferSelect> | undefined): string | undefined {
  const archivePath = (configuration?.payload ?? {}).archivePath;
  return typeof archivePath === "string" ? archivePath : undefined;
}

async function removedDeploymentForGroup(
  group: Readonly<typeof stackRecords.$inferSelect>,
  currentNames: ReadonlySet<string>,
  seenPreviousNames: Set<string>,
): Promise<PreparedDeployment | undefined> {
  const name = eligiblePreviousDeploymentName(group, currentNames, seenPreviousNames);
  if (name === undefined) return undefined;
  if (group.parentId === null) return undefined;
  const previousConfiguration = await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, group.parentId), eq(stackRecords.recordType, "stack-configurations")) });
  const previousComponents = storedComponents((previousConfiguration?.payload ?? {}).components);
  const previousArchive = previousDeploymentArchive(previousConfiguration);
  if (previousConfiguration === undefined || previousComponents.length === 0 || previousArchive === undefined || !isStackStoragePath(previousArchive)) return undefined;
  return { name, destroy: true, components: [...previousComponents].reverse(), archivePath: previousArchive };
}

async function removedStackDeployments(
  stackId: string,
  currentNames: ReadonlySet<string>,
): Promise<readonly PreparedDeployment[]> {
  const previousGroups = await db.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, stackId), eq(stackRecords.recordType, "stack-deployment-groups")), orderBy: [desc(stackRecords.createdAt)] });
  const seenPreviousNames = new Set<string>();
  const removedDeployments: PreparedDeployment[] = [];
  for (const group of previousGroups) {
    const removed = await removedDeploymentForGroup(group, currentNames, seenPreviousNames);
    if (removed !== undefined) removedDeployments.push(removed);
  }
  return removedDeployments;
}

async function prepareStackConfiguration(
  stack: Stack,
  initialPayload: Readonly<Record<string, unknown>>,
  archivePath: string,
  context: DurableJobContext,
): Promise<PreparedStackConfiguration | undefined> {
  if (!isStackStoragePath(archivePath)) throw new Error("The Stack configuration archive path is invalid");
  if (initialPayload.source === "fetch") await fetchStackArchive(stack, archivePath);
  if (!(await Bun.file(archivePath).exists())) throw new Error("The Stack configuration archive is unavailable");
  await validateModuleArchive(archivePath);
  const staging = await mkdtemp(join(tmpdir(), "terrence-stack-config-"));
  try {
    await extractValidatedModuleArchive(archivePath, staging);
    const root = await findArchiveRoot(staging);
    const components = orderComponents(await componentDirectories(root));
    const deployments = await deploymentDefinitions(root);
    const componentPayload: ComponentPayload[] = components.map((component) => ({ name: component.name, directory: component.directory.slice(root.length).replace(/^\//, ""), source: component.source, dependsOn: component.dependsOn }));
    const currentNames = new Set(deployments.map((deployment) => deployment.name));
    const removedDeployments = await removedStackDeployments(stack.id, currentNames);
    const preparedDeployments: PreparedDeployment[] = [
      ...deployments.map((deployment): PreparedDeployment => ({ name: deployment.name, destroy: deployment.destroy, components: componentPayload, archivePath })),
      ...removedDeployments,
    ];
    if (await context.canceled()) return undefined;
    if (components[0] === undefined) throw new Error("Stack configuration contains no components");
    return { componentPayload, preparedDeployments };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function clearPreviousStackDeployments(tx: typeof db, stackId: string, configurationId: string): Promise<void> {
  const oldGroups = await tx.query.stackRecords.findMany({ where: and(eq(stackRecords.stackId, stackId), eq(stackRecords.parentId, configurationId), eq(stackRecords.recordType, "stack-deployment-groups")), columns: { id: true } });
  const groupIds = oldGroups.map((group) => group.id);
  if (groupIds.length === 0) return;
  const oldRuns = await tx.query.stackRecords.findMany({ where: and(inArray(stackRecords.parentId, groupIds), eq(stackRecords.recordType, "stack-deployment-runs")), columns: { id: true } });
  const oldRunIds = oldRuns.map((run) => run.id);
  const oldSteps = oldRunIds.length === 0 ? [] : await tx.query.stackRecords.findMany({ where: and(inArray(stackRecords.parentId, oldRunIds), eq(stackRecords.recordType, "stack-deployment-steps")), columns: { id: true } });
  const stepIds = oldSteps.map((step) => step.id);
  if (stepIds.length > 0) await tx.update(stackAgentJobs).set({ status: "canceled", agentId: null, completedAt: Date.now(), updatedAt: Date.now() }).where(inArray(stackAgentJobs.stepId, stepIds));
  if (oldRunIds.length > 0) {
    await tx.update(stackAgentJobs).set({ status: "canceled", agentId: null, completedAt: Date.now(), updatedAt: Date.now() }).where(inArray(stackAgentJobs.deploymentRunId, oldRunIds));
    await tx.update(stackStateLocks).set({ runId: null, leaseExpiresAt: null, releasedAt: Date.now(), updatedAt: Date.now() }).where(inArray(stackStateLocks.runId, oldRunIds));
    await tx.update(durableJobs).set({ status: "canceled", updatedAt: Date.now() }).where(and(
      eq(durableJobs.kind, "stack-deployment"),
      inArray(durableJobs.status, ["queued", "running"]),
      inArray(durableJobs.dedupeKey, oldRunIds.map((runId) => `stack-run:${runId}`)),
    ));
  }
  if (stepIds.length > 0) await tx.delete(stackRecords).where(inArray(stackRecords.parentId, stepIds));
  if (oldRunIds.length > 0) await tx.delete(stackRecords).where(inArray(stackRecords.parentId, oldRunIds));
  await tx.delete(stackRecords).where(inArray(stackRecords.parentId, groupIds));
  await tx.delete(stackRecords).where(inArray(stackRecords.id, groupIds));
}

async function insertPreparedDeployment(
  tx: typeof db,
  stack: Stack,
  configuration: Readonly<typeof stackRecords.$inferSelect>,
  initialPayload: Readonly<Record<string, unknown>>,
  deployment: PreparedDeployment,
  runIds: string[],
): Promise<void> {
  const deploymentFirst = deployment.components[0];
  if (deploymentFirst === undefined) throw new Error(`Deployment ${deployment.name} contains no components`);
  const groupId = `sdg-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const deploymentRunId = `sdr-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const stepId = `sds-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const now = Date.now();
  await tx.insert(stackRecords).values({ id: groupId, stackId: stack.id, parentId: configuration.id, recordType: "stack-deployment-groups", name: deployment.name, status: "pending", payload: { "deployment-group-config": { "auto-approve-checks": [] }, latestRunId: deploymentRunId }, createdAt: now, updatedAt: now });
  await tx.insert(stackRecords).values({ id: deploymentRunId, stackId: stack.id, parentId: groupId, recordType: "stack-deployment-runs", name: deployment.name, status: "planning", payload: { configurationId: configuration.id, components: deployment.components, archivePath: deployment.archivePath, "plan-mode": initialPayload.speculative === true ? "speculative" : "normal", component: deploymentFirst.name, componentIndex: 0, cycle: 0, destroy: deployment.destroy || initialPayload["destroy-all"] === true }, createdAt: now, updatedAt: now });
  await tx.insert(stackRecords).values({ id: stepId, stackId: stack.id, parentId: deploymentRunId, recordType: "stack-deployment-steps", name: deploymentFirst.name, status: "queued", payload: { "operation-type": "plan", phase: "plan", componentIndex: 0, "requires-state-lock": false, "has-changes": false, "deferred-changes": false }, createdAt: now, updatedAt: now });
  runIds.push(deploymentRunId);
}

async function persistPreparedStackDeployments(
  stack: Stack,
  configuration: Readonly<typeof stackRecords.$inferSelect>,
  initialPayload: Readonly<Record<string, unknown>>,
  deployments: readonly PreparedDeployment[],
  context: DurableJobContext,
): Promise<readonly string[]> {
  const runIds: string[] = [];
  await db.transaction(async (transaction): Promise<void> => {
    const tx = transaction as unknown as typeof db;
    await clearPreviousStackDeployments(tx, stack.id, configuration.id);
    for (const deployment of deployments) {
      if (await context.canceled()) throw new Error("Stack configuration preparation was canceled");
      await insertPreparedDeployment(tx, stack, configuration, initialPayload, deployment, runIds);
    }
  });
  return runIds;
}

export async function runStackConfigurationJob(job: Job, context: DurableJobContext): Promise<void> {
  const configurationId = payloadId(job, "configurationId");
  const configuration = await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, configurationId), eq(stackRecords.recordType, "stack-configurations")) });
  if (configuration === undefined || await context.canceled()) return;
  const stack = await db.query.stacks.findFirst({ where: eq(stacks.id, configuration.stackId) });
  if (stack === undefined) throw new Error("The Stack no longer exists");
  const initialPayload = configuration.payload ?? {};
  const archivePath = typeof initialPayload.archivePath === "string" && initialPayload.archivePath !== "" ? initialPayload.archivePath : join(STACK_STORAGE_DIR, `${configuration.id}.tar.gz`);
  await db.update(stackRecords).set({ status: "preparing", updatedAt: Date.now() }).where(eq(stackRecords.id, configuration.id));
  try {
    const prepared = await prepareStackConfiguration(stack, initialPayload, archivePath, context);
    if (prepared === undefined) return;
    await db.update(stackRecords).set({ status: "ready", payload: { ...initialPayload, archivePath, components: prepared.componentPayload, deployments: prepared.preparedDeployments.map(({ name, destroy }) => ({ name, destroy })) }, updatedAt: Date.now() }).where(eq(stackRecords.id, configuration.id));
    const runIds = await persistPreparedStackDeployments(stack, configuration, initialPayload, prepared.preparedDeployments, context);
    for (const runId of runIds) await scheduleStackRun(runId);
    await db.update(stackRecords).set({ status: "completed", updatedAt: Date.now() }).where(eq(stackRecords.id, configuration.id));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    if (await context.canceled()) return;
    await db.update(stackRecords).set({ status: "failed", payload: { ...initialPayload, archivePath, error: detail }, updatedAt: Date.now() }).where(eq(stackRecords.id, configuration.id));
    await addDiagnostic(configuration.id, stack.id, detail);
    throw error;
  }
}
