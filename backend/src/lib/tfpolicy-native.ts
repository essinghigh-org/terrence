import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { and, asc, desc, eq } from "drizzle-orm";
import type { db } from "../db";
import { storageDir } from "../db/driver";
import { adminTfpolicyVersions, policyChecks, policySetVersions, runs, type policySets } from "../db/schema";
import type { DeepReadonly } from "./types";
import type { WorkspacePolicyEvaluation, WorkspacePolicySnapshot } from "./workspace-policy-gate";
import { extractSafeTarArchive } from "./archive";
import { encryptSecret, decryptSecret } from "./secrets";
import { hashAuthenticationToken } from "./token-service";
import { mintRunToken, revokeRunTokenValue } from "./run-token";
import { newResourceId } from "./resource-id";
import { runNetDenyEnabled } from "./sandbox";

type Database = Readonly<typeof db>;
type PinnedFile = Readonly<{ path: string; sha256: string }>;
type Runtime = Readonly<
  Record<"engine" | "runner" | "supervisor" | "shim" | "recorder" | "plugin", PinnedFile> & {
    patchSha256: string;
    entitlementCA?: PinnedFile;
  }
>;
type Profile = Readonly<{
  schemaVersion: 1;
  owner: PinnedFile;
  runtime: Runtime;
  pluginVersion: string;
  catalogSha256: string;
  cgroupRoot: string;
  privateParent: string;
  digest: string;
}>;
export type Receipt = Readonly<{ payload: string; mac: string }>;
export type NativePolicy = Readonly<{ file: string; address: string; enforcement: string; result: string }>;
type OwnerResult = Readonly<{
  schemaVersion: number;
  runId: string;
  workspaceId: string;
  command: string;
  directory: string;
  exitCode: number;
  verified: boolean;
  cgroupEmpty: boolean;
  cancelled: boolean;
  planSha256?: string;
  runtimeSha256?: string;
  policySnapshotSha256?: string;
  receipt?: Receipt;
  evidence: Readonly<{ allows: boolean; targets: number; policies: readonly NativePolicy[] }>;
}>;
export type NativeSnapshotInfo = Readonly<{
  sources: readonly Readonly<{
    policySetId: string;
    version: typeof policySetVersions.$inferSelect | null;
    archiveSha256: string | null;
  }>[];
  catalog: readonly (typeof adminTfpolicyVersions.$inferSelect)[];
  profileDigest: string | null;
}>;
type NativeState = Readonly<{ profileDigest: string; roots: readonly string[]; receipt: Receipt }>;
export type NativeRun = Readonly<{
  runId: string;
  workspaceId: string;
  organizationName: string;
  evaluation: DeepReadonly<WorkspacePolicyEvaluation>;
  profile: Profile;
  roots: readonly string[];
  directory: string;
  state?: NativeState;
}>;
export type NativeLaunch = (
  args: readonly string[],
  cgroupRoot: string,
  controlDirectory: string,
  timeoutMs: number,
) => Promise<Readonly<{ code: number; stdout: string; stderr: string }>>;
type SavedPlanInput = Readonly<{
  bytes: Buffer;
  receipt: Receipt;
  overrides: readonly Readonly<{ file: string; address: string }>[];
}>;
export type NativeVerdict = Readonly<{ valid: boolean; hardFailed: boolean; softFailed: boolean }>;

const LIMIT = 20 * 1024 * 1024;
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Hashing reads the input buffer without mutation.
const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid native policy runtime data");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("Invalid native policy runtime identity");
  return value;
}
function pinned(value: unknown): PinnedFile {
  const r = record(value);
  if (!digest(r["sha256"])) throw new Error("Native runtime SHA-256 is required");
  return { path: text(r["path"]), sha256: r["sha256"] };
}
function within(root: string, path: string): boolean {
  const p = relative(root, path);
  return p === "" || (p !== ".." && !p.startsWith(`..${sep}`) && !p.startsWith(sep));
}
function resourcePath(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid native policy run identity");
  return value;
}
async function boundedFile(path: string, maximum = LIMIT): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximum) throw new Error("Native policy file is not a bounded regular file");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function runtimeProfile(): Promise<Profile | null> {
  const path = process.env["TERRENCE_TFPOLICY_RUNTIME_PROFILE"];
  if (path === undefined || path === "") return null;
  const bytes = await boundedFile(path, 65536);
  const info = await stat(path);
  if ((info.mode & 0o222) !== 0 || (await realpath(path)) !== path)
    throw new Error("Native runtime profile must be canonical and read-only");
  const value = record(JSON.parse(bytes.toString("utf8")) as unknown),
    source = record(value["runtime"]);
  if (value["schemaVersion"] !== 1 || !digest(source["patchSha256"]) || !digest(value["catalogSha256"]))
    throw new Error("Unsupported native runtime profile");
  const runtime: Runtime = {
    engine: pinned(source["engine"]),
    runner: pinned(source["runner"]),
    supervisor: pinned(source["supervisor"]),
    shim: pinned(source["shim"]),
    recorder: pinned(source["recorder"]),
    plugin: pinned(source["plugin"]),
    patchSha256: source["patchSha256"],
    ...(source["entitlementCA"] === undefined ? {} : { entitlementCA: pinned(source["entitlementCA"]) }),
  };
  return {
    schemaVersion: 1,
    owner: pinned(value["owner"]),
    runtime,
    pluginVersion: text(value["pluginVersion"]),
    catalogSha256: value["catalogSha256"],
    cgroupRoot: text(value["cgroupRoot"]),
    privateParent: text(value["privateParent"]),
    digest: sha(bytes),
  };
}

export async function nativePolicySnapshotInfo(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  sets: readonly DeepReadonly<typeof policySets.$inferSelect>[],
): Promise<NativeSnapshotInfo | undefined> {
  const native = sets.filter((set) => set.kind === "tfpolicy");
  if (native.length === 0) return undefined;
  if (native.length > 32) throw new Error("Native policy scope exceeds the 32-set runtime limit");
  const [profile, catalog, sources] = await Promise.all([
    runtimeProfile(),
    database.query.adminTfpolicyVersions.findMany({ orderBy: [asc(adminTfpolicyVersions.version)] }),
    Promise.all(
      native.map(async (set) => {
        const version = await database.query.policySetVersions.findFirst({
          where: and(eq(policySetVersions.policySetId, set.id), eq(policySetVersions.status, "ready")),
          orderBy: [desc(policySetVersions.createdAt), desc(policySetVersions.id)],
        });
        let archiveSha256: string | null = null;
        if (version?.archivePath !== null && version?.archivePath !== undefined) {
          try {
            archiveSha256 = sha(await boundedFile(version.archivePath));
          } catch {
            /* a missing archive is never execution-ready */
          }
        }
        return { policySetId: set.id, version: version ?? null, archiveSha256 };
      }),
    ),
  ]);
  return { sources, catalog, profileDigest: profile?.digest ?? null };
}

async function probeProfile(profile: Profile): Promise<void> {
  const binary = await boundedFile(profile.owner.path, 512 * 1024 * 1024);
  const info = await stat(profile.owner.path);
  if (
    sha(binary) !== profile.owner.sha256 ||
    (info.mode & 0o222) !== 0 ||
    (await realpath(profile.owner.path)) !== profile.owner.path
  )
    throw new Error("Native execution owner does not match its approved pin");
  const control = await mkdtemp(join(profile.privateParent, "p-"));
  try {
    const path = join(control, "probe.json");
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, runtime: profile.runtime, cgroupRoot: profile.cgroupRoot }),
      { mode: 0o600 },
    );
    const child = Bun.spawn([profile.owner.path, "probe", "--config", path], {
      env: { PATH: "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const probe = record(JSON.parse(output || "{}") as unknown);
    if (code !== 0 || probe["ready"] !== true || probe["receiptVersion"] !== 2)
      throw new Error(`Native policy runtime is unavailable: ${error.trim() || "readiness checks failed"}`);
  } finally {
    await rm(control, { recursive: true, force: true });
  }
}

async function freezeSource(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await freezeSource(child);
    else if (entry.isFile()) await chmod(child, 0o400);
    else throw new Error("Native policy sources cannot contain links or special files");
  }
  await chmod(path, 0o500);
}

async function thawDirectories(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await thawDirectories(join(path, entry.name));
  }
}

export async function cleanupNativeRun(runId: string): Promise<void> {
  const path = join(storageDir, "native-policy", resourcePath(runId));
  try {
    await thawDirectories(path);
    await rm(path, { recursive: true, force: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function extractSource(
  archive: string,
  directory: string,
  index: number,
  policiesPath: string | null,
): Promise<Readonly<{ repository: string; root: string }>> {
  const extracted = join(directory, "sources", String(index));
  try {
    await stat(extracted);
  } catch {
    await mkdir(extracted, { mode: 0o700 });
    await extractSafeTarArchive(archive, extracted);
  }
  const entries = await readdir(extracted, { withFileTypes: true });
  const repository =
    entries.length === 1 && entries[0]?.isDirectory() === true ? join(extracted, entries[0].name) : extracted;
  const root = resolve(repository, policiesPath ?? ".");
  if (!within(repository, root)) throw new Error("Native policies-path escapes its source archive");
  const files = await readdir(root, { withFileTypes: true });
  if (!files.some((file) => file.isFile() && file.name.endsWith(".policy.hcl")))
    throw new Error("Native policies-path must contain .policy.hcl sources");
  return { repository, root };
}

async function validateSourceVersion(
  repository: string,
  selectedVersion: string | null,
  latest: string | undefined,
  pluginVersion: string,
): Promise<void> {
  let fileVersion: string | undefined;
  try {
    fileVersion = (await boundedFile(join(repository, ".tfpolicy-version"), 1024)).toString("utf8").trim();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const selected = selectedVersion === "latest" || selectedVersion === null ? (fileVersion ?? latest) : selectedVersion;
  if (selected !== pluginVersion || (fileVersion !== undefined && fileVersion !== pluginVersion))
    throw new Error("Native policy tool selection differs from the installed pinned plugin");
}

async function prepareSource(
  snapshot: DeepReadonly<WorkspacePolicySnapshot>,
  profile: Profile,
  directory: string,
  index: number,
  set: DeepReadonly<typeof policySets.$inferSelect>,
  latest: string | undefined,
): Promise<string> {
  if (snapshot.parameters.some((parameter) => parameter.policySetId === set.id))
    throw new Error("Native policy set parameters have no supported plugin input contract");
  const source = snapshot.nativeInfo?.sources.find((item) => item.policySetId === set.id);
  if (
    source?.version?.archivePath === null ||
    source?.version?.archivePath === undefined ||
    source.archiveSha256 === null
  )
    throw new Error(`Native policy set ${set.name} has no ready source archive`);
  if (sha(await boundedFile(source.version.archivePath)) !== source.archiveSha256)
    throw new Error("Native policy source changed during preparation");
  const { repository, root } = await extractSource(source.version.archivePath, directory, index, set.policiesPath);
  await validateSourceVersion(repository, set.policyToolVersion, latest, profile.pluginVersion);
  await freezeSource(root);
  return root;
}

async function probeLocalRuntime(profile: Profile, local: boolean): Promise<void> {
  if (!local) return;
  if (runNetDenyEnabled())
    throw new Error("Native policy entitlement networking is unavailable with the deny network profile");
  await probeProfile(profile);
}

export async function prepareNativeRun(
  evaluation: DeepReadonly<WorkspacePolicyEvaluation>,
  runId: string,
  workspace: Readonly<{ id: string; orgId: string }>,
  organizationName: string,
  requestedTool: string,
  requestedVersion: string,
  local = true,
): Promise<NativeRun | null> {
  const snapshot = evaluation.snapshot,
    native = snapshot.sets.filter((set) => set.kind === "tfpolicy");
  if (native.length === 0) return null;
  if (requestedTool !== "terraform" || !["latest", "1.17.1"].includes(requestedVersion))
    throw new Error("Native policy execution requires the configured strict Terraform 1.17.1 engine");
  const profile = await runtimeProfile();
  if (profile === null)
    throw new Error("tfpolicy runtime is not supported until TERRENCE_TFPOLICY_RUNTIME_PROFILE is configured");
  await probeLocalRuntime(profile, local);
  const catalog = snapshot.nativeInfo?.catalog.find((row) => row.version === profile.pluginVersion && row.enabled);
  const architecture = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : process.arch;
  if (
    catalog === undefined ||
    !catalog.archs.some(
      (arch) => arch.os === "linux" && arch.arch === architecture && arch.sha === profile.catalogSha256,
    )
  )
    throw new Error("The installed native plugin is not pinned in the enabled version catalog");
  const directory = join(storageDir, "native-policy", resourcePath(runId), resourcePath(evaluation.id));
  await mkdir(join(directory, "sources"), { recursive: true, mode: 0o700 });
  const roots: string[] = [];
  const latest = snapshot.nativeInfo?.catalog
    .filter((row) => row.enabled && !row.beta && !row.deprecated && !row.version.includes("-"))
    .map((row) => row.version)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .at(-1);
  for (const [index, set] of native.entries())
    roots.push(await prepareSource(snapshot, profile, directory, index, set, latest));
  return { runId, workspaceId: workspace.id, organizationName, evaluation, profile, roots, directory };
}

export function nativeRunKey(runId: string, evaluationId: string): string {
  return hashAuthenticationToken(`native-policy-receipt:v1:${runId}:${evaluationId}`);
}
export function decodeNativeReceipt(
  receipt: Receipt,
  runId: string,
  workspaceId: string,
  evaluationId: string,
  fingerprint: string,
  stage: "plan" | "apply" = "plan",
): Record<string, unknown> {
  const bytes = Buffer.from(receipt.payload, "base64url"),
    mac = Buffer.from(receipt.mac, "hex");
  const expected = createHmac("sha256", Buffer.from(nativeRunKey(runId, evaluationId), "hex"))
    .update(bytes)
    .digest();
  if (bytes.length > 512 * 1024 || mac.length !== expected.length || !timingSafeEqual(mac, expected))
    throw new Error("Native plan admission signature is invalid");
  const payload = record(JSON.parse(bytes.toString("utf8")) as unknown);
  if (
    payload["version"] !== 2 ||
    payload["stage"] !== stage ||
    payload["runId"] !== runId ||
    payload["workspaceId"] !== workspaceId ||
    payload["evaluationId"] !== evaluationId ||
    payload["policyFingerprint"] !== fingerprint ||
    ![
      "planSha256",
      "planJsonSha256",
      "runtimeSha256",
      "policySnapshotSha256",
      "auditSha256",
      "journalSha256",
      "nonce",
    ].every((key) => digest(payload[key]))
  )
    throw new Error("Native plan admission is stale or belongs to another run");
  return payload;
}

export async function nativeCheckpointState(
  check: Readonly<{ result: Readonly<Record<string, unknown>> | null }>,
): Promise<NativeState | null> {
  const encrypted = check.result?.["nativeExecution"];
  return typeof encrypted === "string" ? (JSON.parse(await decryptSecret(encrypted)) as NativeState) : null;
}

type NativeCheck = DeepReadonly<typeof policyChecks.$inferSelect>;
function nativeSetAdmission(
  selected: readonly NativeCheck[],
  snapshot: DeepReadonly<WorkspacePolicySnapshot>,
  checkpointId: string,
  allowOverride: boolean,
): string | null {
  for (const set of snapshot.sets.filter((item) => item.kind === "tfpolicy")) {
    const matches = selected.filter((check) => check.policySetId === set.id),
      check = matches[0];
    if (matches.length !== 1 || check === undefined) return "Native policy evaluation is missing or duplicated";
    if (check.status === "passed") continue;
    if (check.status === "overridden" && check.result?.["overrideEvaluationId"] === checkpointId) continue;
    if (allowOverride && check.status === "soft_failed") continue;
    return `Native policy set ${set.name} ${check.status}; an authorized override or a successful evaluation is required`;
  }
  return null;
}
function receiptPolicyFile(roots: readonly string[], value: unknown): Readonly<{ index: number; file: string }> {
  const reference = text(value),
    slash = reference.indexOf("/"),
    index = Number(reference.slice(0, slash)),
    path = reference.slice(slash + 1);
  const root = roots[index];
  if (
    slash < 1 ||
    String(index) !== reference.slice(0, slash) ||
    root === undefined ||
    path === "" ||
    path.includes("\\")
  )
    throw new Error("Invalid native receipt policy reference");
  const file = resolve(root, path);
  if (!within(root, file) || relative(root, file).split(sep).join("/") !== path)
    throw new Error("Native receipt policy reference escapes its snapshot");
  return { index, file };
}
function nativeDenialAdmission(
  payload: Readonly<Record<string, unknown>>,
  state: NativeState,
  selected: readonly NativeCheck[],
  snapshot: DeepReadonly<WorkspacePolicySnapshot>,
  checkpointId: string,
  allowOverride: boolean,
): string | null {
  if (typeof payload["allows"] !== "boolean") return "Native policy admission has an invalid disposition";
  if (!Array.isArray(payload["denials"])) return "Native policy admission is missing its denial inventory";
  const nativeSets = snapshot.sets.filter((set) => set.kind === "tfpolicy");
  for (const raw of payload["denials"]) {
    const denial = record(raw);
    const { index } = receiptPolicyFile(state.roots, denial["file"]);
    const set = nativeSets[index];
    const check = selected.find((item) => item.policySetId === set?.id);
    if (denial["enforcement"] !== "mandatory_overridable" || check === undefined)
      return "Native mandatory policy denial blocks apply";
    const approved = check.status === "overridden" && check.result?.["overrideEvaluationId"] === checkpointId;
    if (!approved && !(allowOverride && check.status === "soft_failed"))
      return "Native policy denial requires an authorized override from this evaluation";
  }
  if (!payload["allows"] && payload["denials"].length === 0)
    return "Native policy admission has no verifiable disposition";
  return null;
}

export async function nativeAdmissionError(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  workspace: Readonly<{ id: string; orgId: string }>,
  runId: string,
  checkpoint: Readonly<{ id: string; result: Readonly<Record<string, unknown>> | null }>,
  snapshot: DeepReadonly<WorkspacePolicySnapshot>,
  allowOverride: boolean,
): Promise<string | null> {
  try {
    const state = await nativeCheckpointState(checkpoint);
    if (state === null || snapshot.nativeInfo?.profileDigest !== state.profileDigest)
      return "Native policy plan admission is missing or its runtime changed; create a new plan";
    const payload = decodeNativeReceipt(state.receipt, runId, workspace.id, checkpoint.id, snapshot.fingerprint);
    const checks = await database.query.policyChecks.findMany({ where: eq(policyChecks.runId, runId) });
    const selected = checks.filter(
      (check) => check.result?.["policyEvaluationId"] === checkpoint.id && check.result["native"] === true,
    );
    const setError = nativeSetAdmission(selected, snapshot, checkpoint.id, allowOverride);
    if (setError !== null) return setError;
    return nativeDenialAdmission(payload, state, selected, snapshot, checkpoint.id, allowOverride);
  } catch {
    return "Native policy plan admission could not be verified; create a new plan";
  }
}

export async function nativePlanBytes(runId: string, evaluationId?: string): Promise<Buffer | null> {
  if (evaluationId === undefined) return null;
  return Buffer.from(
    await decryptSecret(
      (
        await boundedFile(
          join(storageDir, "native-policy", resourcePath(runId), resourcePath(evaluationId), "plan.enc"),
          64 * 1024 * 1024,
        )
      ).toString("utf8"),
    ),
    "base64",
  );
}
export async function nativePlanJson(runId: string, evaluationId: string): Promise<Record<string, unknown>> {
  return record(
    JSON.parse(
      await decryptSecret(
        (
          await boundedFile(
            join(storageDir, "native-policy", resourcePath(runId), resourcePath(evaluationId), "plan-json.enc"),
            64 * 1024 * 1024,
          )
        ).toString("utf8"),
      ),
    ) as unknown,
  );
}

async function readOwnerLogs(directory: string, onLog: (text: string) => Promise<void>): Promise<void> {
  for (const name of ["stdout", "stderr"]) {
    try {
      await onLog((await boundedFile(join(directory, name))).toString("utf8"));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function validateOwnerResult(
  result: OwnerResult,
  context: NativeRun,
  command: string,
  error: string,
  onLog: (text: string) => Promise<void>,
): Promise<void> {
  if (
    result.schemaVersion !== 1 ||
    result.runId !== context.runId ||
    result.workspaceId !== context.workspaceId ||
    result.command !== command ||
    typeof result.directory !== "string" ||
    !within(context.profile.privateParent, result.directory)
  )
    throw new Error("Invalid native owner response");
  await readOwnerLogs(result.directory, onLog);
  if (!result.verified || !result.cgroupEmpty || result.cancelled) {
    if (command === "apply")
      await onLog(
        "[terrence] Native policy execution failed after apply started. Infrastructure may already have changed. Terrence will attempt to capture actual state; no rollback occurred.",
      );
    throw new Error(`Native ${command} failed: ${error.trim() || "runtime evidence was incomplete"}`);
  }
  if (command === "init" && !result.evidence.allows) throw new Error("Native policy initialization denied execution");
}

async function publishNativePlan(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  context: NativeRun,
  result: OwnerResult,
): Promise<void> {
  if (result.receipt === undefined) throw new Error("Native plan did not produce authenticated admission");
  const receipt = decodeNativeReceipt(
    result.receipt,
    context.runId,
    context.workspaceId,
    context.evaluation.id,
    context.evaluation.snapshot.fingerprint,
  );
  const bytes = await boundedFile(join(result.directory, "tfplan"));
  if (sha(bytes) !== receipt["planSha256"]) throw new Error("Native saved plan changed before publication");
  const json = (await boundedFile(join(result.directory, "plan.json"))).toString("utf8");
  if (sha(json) !== receipt["planJsonSha256"]) throw new Error("Native plan JSON changed before publication");
  await persistNativePlan(database, context, result.receipt, bytes.toString("base64"), json, result.evidence.policies);
}

export async function persistNativePlan(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  context: NativeRun,
  receipt: Receipt,
  planBase64: string,
  planJson: string,
  policies: readonly NativePolicy[],
): Promise<void> {
  await writeFile(join(context.directory, "plan.enc"), await encryptSecret(planBase64), {
    mode: 0o600,
  });
  await writeFile(join(context.directory, "plan-json.enc"), await encryptSecret(planJson), { mode: 0o600 });
  const state: NativeState = {
    profileDigest: context.profile.digest,
    roots: context.roots,
    receipt,
  };
  const checkpoint = await database.query.policyChecks.findFirst({
    where: eq(policyChecks.id, context.evaluation.id),
  });
  if (checkpoint === undefined) throw new Error("Native evaluation checkpoint disappeared");
  await database
    .update(policyChecks)
    .set({ result: { ...checkpoint.result, nativeExecution: await encryptSecret(JSON.stringify(state)) } })
    .where(eq(policyChecks.id, context.evaluation.id));
  for (const [index, set] of context.evaluation.snapshot.sets.filter((item) => item.kind === "tfpolicy").entries()) {
    const root = context.roots[index] ?? "",
      selected = policies.filter((policy) => within(root, policy.file));
    const hard = selected.some((policy) => policy.result === "DenyResult" && policy.enforcement === "mandatory"),
      soft = selected.some(
        (policy) => policy.result === "DenyResult" && policy.enforcement === "mandatory_overridable",
      );
    await database.insert(policyChecks).values({
      id: newResourceId("pchk"),
      runId: context.runId,
      policySetId: set.id,
      status: hard ? "failed" : soft ? "soft_failed" : "passed",
      result: {
        native: true,
        policyEvaluationId: context.evaluation.id,
        nativePolicies: selected.map((policy) => ({ ...policy, file: relative(root, policy.file) })),
        nativeEnforcement: hard ? "mandatory" : soft ? "mandatory_overridable" : "advisory",
      },
      createdAt: Date.now(),
    });
  }
}

export async function runNativeStage(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  context: NativeRun,
  command: "init" | "plan" | "apply",
  workRoot: string,
  cwd: string,
  environment: Readonly<Record<string, string>>,
  args: readonly string[],
  cgroupRoot: string,
  timeoutMs: number,
  launch: NativeLaunch,
  onLog: (text: string) => Promise<void>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Buffer is read without mutation.
  savedPlan?: SavedPlanInput,
): Promise<OwnerResult> {
  if (!within(context.profile.cgroupRoot, cgroupRoot))
    throw new Error("Native execution requires the configured delegated cgroup hierarchy");
  const control = await mkdtemp(join(context.profile.privateParent, "c-"));
  const token = await mintRunToken(
    context.runId,
    context.workspaceId,
    context.evaluation.snapshot.sets[0]?.orgId ?? "",
    Math.min(timeoutMs + 60000, 86400000),
  );
  let result: OwnerResult | undefined;
  try {
    const config: Record<string, unknown> = {
      schemaVersion: 1,
      runtime: context.profile.runtime,
      runId: context.runId,
      workspaceId: context.workspaceId,
      evaluationId: context.evaluation.id,
      policyFingerprint: context.evaluation.snapshot.fingerprint,
      receiptKey: nativeRunKey(context.runId, context.evaluation.id),
      command,
      workRoot,
      workDirectory: cwd,
      privateParent: context.profile.privateParent,
      cgroupRoot,
      policyRoots: context.roots,
      environment,
      arguments: args,
      runContext: {
        host: new URL(process.env["PUBLIC_URL"] ?? "http://localhost:3000").host,
        organization: context.organizationName,
        token,
      },
      timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
    };
    if (savedPlan !== undefined) {
      const path = join(control, "tfplan");
      await writeFile(path, savedPlan.bytes, { mode: 0o400 });
      config["savedPlan"] = { path, sha256: sha(savedPlan.bytes) };
      config["planReceipt"] = savedPlan.receipt;
      config["overrides"] = savedPlan.overrides;
    }
    const path = join(control, "owner.json");
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    const observed = await launch(
      [context.profile.owner.path, "execute", "--config", path],
      cgroupRoot,
      control,
      timeoutMs + 15000,
    );
    result = JSON.parse(observed.stdout || "{}") as OwnerResult;
    await validateOwnerResult(result, context, command, observed.stderr, onLog);
    if (command === "plan") await publishNativePlan(database, context, result);
    return result;
  } finally {
    await revokeRunTokenValue(token);
    await rm(control, { recursive: true, force: true });
    if (
      result?.directory !== undefined &&
      within(context.profile.privateParent, result.directory) &&
      result.directory !== context.profile.privateParent
    )
      await rm(result.directory, { recursive: true, force: true });
  }
}

export async function nativePolicyVerdict(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  runId: string,
  evaluation: DeepReadonly<WorkspacePolicyEvaluation>,
): Promise<NativeVerdict> {
  if (!evaluation.snapshot.sets.some((set) => set.kind === "tfpolicy"))
    return { valid: false, hardFailed: false, softFailed: false };
  const checkpoint = await database.query.policyChecks.findFirst({ where: eq(policyChecks.id, evaluation.id) });
  if (checkpoint === undefined) return { valid: false, hardFailed: true, softFailed: false };
  const checks = await database.query.policyChecks.findMany({ where: eq(policyChecks.runId, runId) });
  const selected = checks.filter(
    (check) => check.result?.["native"] === true && check.result["policyEvaluationId"] === evaluation.id,
  );
  const state = await nativeCheckpointState(checkpoint);
  if (state === null) return { valid: false, hardFailed: true, softFailed: false };
  try {
    const receipt = decodeNativeReceipt(
      state.receipt,
      runId,
      (await database.query.runs.findFirst({ where: eq(runs.id, runId) }))?.workspaceId ?? "",
      evaluation.id,
      evaluation.snapshot.fingerprint,
    );
    if (receipt["allows"] === false && (!Array.isArray(receipt["denials"]) || receipt["denials"].length === 0))
      return { valid: false, hardFailed: true, softFailed: false };
  } catch {
    return { valid: false, hardFailed: true, softFailed: false };
  }
  return {
    valid: true,
    hardFailed: selected.some((check) => check.status === "failed" || check.status === "errored"),
    softFailed: selected.some((check) => check.status === "soft_failed"),
  };
}

export async function nativeApplyInput(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  context: NativeRun,
  source: "saved-plan" | "native-artifact" = "saved-plan",
): Promise<
  Readonly<{ bytes: Buffer; receipt: Receipt; overrides: readonly Readonly<{ file: string; address: string }>[] }>
> {
  const checkpoint = await database.query.policyChecks.findFirst({ where: eq(policyChecks.id, context.evaluation.id) });
  const state = checkpoint === undefined ? null : await nativeCheckpointState(checkpoint);
  if (
    state === null ||
    state.profileDigest !== context.profile.digest ||
    JSON.stringify(state.roots) !== JSON.stringify(context.roots)
  )
    throw new Error("Native plan source or runtime changed after admission");
  const payload = decodeNativeReceipt(
    state.receipt,
    context.runId,
    context.workspaceId,
    context.evaluation.id,
    context.evaluation.snapshot.fingerprint,
  );
  const bytes =
    source === "native-artifact"
      ? await nativePlanBytes(context.runId, context.evaluation.id)
      : Buffer.from(
          await decryptSecret(
            (
              await boundedFile(
                join(storageDir, "saved-plans", resourcePath(context.runId), "tfplan"),
                64 * 1024 * 1024,
              )
            ).toString("utf8"),
          ),
          "base64",
        );
  if (bytes === null) throw new Error("Native saved plan is missing");
  if (sha(bytes) !== payload["planSha256"])
    throw new Error("Native saved plan does not match its authenticated admission");
  const checks = await database.query.policyChecks.findMany({ where: eq(policyChecks.runId, context.runId) });
  const overrides: { file: string; address: string }[] = [];
  const denied = Array.isArray(payload["denials"]) ? payload["denials"] : [];
  const nativeSets = context.evaluation.snapshot.sets.filter((set) => set.kind === "tfpolicy");
  for (const item of denied) {
    const denial = record(item),
      address = text(denial["address"]);
    const { index, file } = receiptPolicyFile(state.roots, denial["file"]);
    const set = nativeSets[index];
    const approved =
      set !== undefined &&
      checks.some(
        (check) =>
          check.policySetId === set.id &&
          check.status === "overridden" &&
          check.result?.["policyEvaluationId"] === context.evaluation.id &&
          check.result["overrideEvaluationId"] === context.evaluation.id,
      );
    if (approved && denial["enforcement"] === "mandatory_overridable") overrides.push({ file, address });
  }
  return { bytes, receipt: state.receipt, overrides };
}
