import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { readdir, open, writeFile, rename, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { db } from "../db";
import { storageDir } from "../db/driver";
import type { DeepReadonly } from "./types";
import { encryptSecret, decryptSecret } from "./secrets";
import { mintRunToken, revokeRunTokenValue } from "./run-token";
import {
  nativeRunKey,
  decodeNativeReceipt,
  nativeApplyInput,
  nativePlanBytes,
  persistNativePlan,
  type NativeRun,
  type NativePolicy,
  type Receipt,
} from "./tfpolicy-native";

type Database = Readonly<typeof db>;
type Job = Readonly<{ id: string; fencingToken: number; phase: string }>;
type Entry = Readonly<{ path: string; kind: "directory" | "file"; data?: string; sha256?: string }>;
export type NativeCandidate = Readonly<{
  context: NativeRun;
  receipt: Receipt;
  payload: Readonly<Record<string, unknown>>;
  plan: string;
  planJson: string;
  policies: readonly NativePolicy[];
}>;
const LIMIT = 16 * 1024 * 1024;
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Hashing reads the byte buffer without mutation.
const hash = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid native agent artifact");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid native agent artifact field");
  return value;
}
function jobFile(context: Readonly<{ directory: string }>, job: Job, suffix: string): string {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(job.id) ||
    !Number.isSafeInteger(job.fencingToken) ||
    job.fencingToken < 1 ||
    !["plan", "apply"].includes(job.phase)
  )
    throw new Error("Invalid native agent lease");
  return join(context.directory, `agent-${job.id}-${job.fencingToken}-${suffix}.enc`);
}
async function readBounded(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum)
      throw new Error("Native artifact exceeds its bounded file contract");
    const bytes = await file.readFile();
    if (bytes.length > maximum) throw new Error("Native artifact changed during capture");
    return bytes;
  } finally {
    await file.close();
  }
}

function goJSON(value: unknown): string {
  return (
    JSON.stringify(value).replace(
      /[<>&\u2028\u2029]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ) + "\n"
  );
}

async function sources(
  context: NativeRun,
): Promise<Readonly<{ roots: readonly (readonly Entry[])[]; sha256: string }>> {
  const roots: Entry[][] = [],
    identity = createHash("sha256");
  let total = 0,
    count = 0;
  for (const [index, root] of context.roots.entries()) {
    const entries: Entry[] = [];
    const visit = async (path: string): Promise<void> => {
      if (++count > 10000) throw new Error("Native source inventory exceeds limit");
      const name = relative(root, path).split(sep).join("/") || ".";
      entries.push({ path: name, kind: "directory" });
      identity.update(goJSON({ Root: index, Path: name, Hash: "directory" }));
      const children = (await readdir(path, { withFileTypes: true })).sort((a, b) =>
        Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
      );
      for (const child of children) {
        const file = join(path, child.name);
        if (child.isDirectory()) await visit(file);
        else if (child.isFile()) {
          const bytes = await readBounded(file, 20 * 1024 * 1024 - total);
          total += bytes.length;
          if (total > 20 * 1024 * 1024 || ++count > 10000) throw new Error("Native source content exceeds limit");
          const name = relative(root, file).split(sep).join("/"),
            sha256 = hash(bytes);
          entries.push({ path: name, kind: "file", data: bytes.toString("base64"), sha256 });
          identity.update(goJSON({ Root: index, Path: name, Hash: sha256 }));
        } else throw new Error("Native source contains an unsupported entry");
      }
    };
    await visit(root);
    roots.push(entries);
  }
  return { roots, sha256: identity.digest("hex") };
}
function runtimeIdentity(context: NativeRun): string {
  const r = context.profile.runtime;
  const fields: Record<string, string> = {
    engine: r.engine.sha256,
    runner: r.runner.sha256,
    supervisor: r.supervisor.sha256,
    shim: r.shim.sha256,
    recorder: r.recorder.sha256,
    plugin: r.plugin.sha256,
    patchSha256: r.patchSha256,
    entitlementCA: r.entitlementCA?.sha256 ?? "",
  };
  return hash(
    JSON.stringify(Object.fromEntries(Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))),
  );
}
async function nativeToken(context: NativeRun, job: Job): Promise<string> {
  const path = jobFile(context, job, "token");
  try {
    return await decryptSecret((await readBounded(path, 16 * 1024)).toString("utf8"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = await mintRunToken(
    context.runId,
    context.workspaceId,
    context.evaluation.snapshot.sets[0]?.orgId ?? "",
    70 * 60 * 1000,
  );
  try {
    await writeFile(path, await encryptSecret(token), { flag: "wx", mode: 0o600 });
    return token;
  } catch (error: unknown) {
    await revokeRunTokenValue(token);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return decryptSecret((await readBounded(path, 16 * 1024)).toString("utf8"));
  }
}
export async function revokeNativeAgentToken(context: Readonly<{ directory: string }>, job: Job): Promise<void> {
  try {
    await revokeRunTokenValue(
      await decryptSecret((await readBounded(jobFile(context, job, "token"), 16 * 1024)).toString("utf8")),
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
export async function revokeNativeAgentLease(runId: string, evaluationId: string, job: Job): Promise<void> {
  if (![runId, evaluationId].every((value) => /^[A-Za-z0-9_-]{1,128}$/.test(value)))
    throw new Error("Invalid native lease identity");
  await revokeNativeAgentToken({ directory: join(storageDir, "native-policy", runId, evaluationId) }, job);
}

export async function nativeAgentManifest(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  context: NativeRun,
  job: Job,
  inputState: string | null = null,
): Promise<Record<string, unknown>> {
  const source = await sources(context),
    input = job.phase === "apply" ? await nativeApplyInput(database, context, "native-artifact") : undefined;
  const overrides =
    input?.overrides.map((override) => {
      const index = context.roots.findIndex((root) => override.file.startsWith(root + sep));
      if (index < 0) throw new Error("Native approval escaped snapshot");
      return {
        file: `${index}/${relative(context.roots[index] ?? "", override.file)
          .split(sep)
          .join("/")}`,
        address: override.address,
      };
    }) ?? [];
  return {
    schemaVersion: 2,
    executionId: `${job.id}:${job.fencingToken}:${job.phase}`,
    runId: context.runId,
    workspaceId: context.workspaceId,
    evaluationId: context.evaluation.id,
    policyFingerprint: context.evaluation.snapshot.fingerprint,
    receiptKey: nativeRunKey(context.runId, context.evaluation.id),
    ownerSha256: context.profile.owner.sha256,
    runtimeSha256: runtimeIdentity(context),
    sourceSha256: source.sha256,
    sources: source.roots,
    inputState:
      inputState === null ? null : { data: Buffer.from(inputState).toString("base64"), sha256: hash(inputState) },
    runContext: {
      host: new URL(process.env["PUBLIC_URL"] ?? "").host,
      organization: context.organizationName,
      token: await nativeToken(context, job),
    },
    ...(input === undefined
      ? {}
      : {
          savedPlan: { data: input.bytes.toString("base64"), sha256: hash(input.bytes) },
          planReceipt: input.receipt,
          overrides,
        }),
  };
}
function receiptFrom(value: unknown): Receipt {
  const r = object(value);
  return { payload: string(r["payload"]), mac: string(r["mac"]) };
}
function auditPolicy(value: unknown, roots: readonly unknown[], context: NativeRun): NativePolicy {
  const p = object(value),
    file = string(p["file"]),
    index = roots.findIndex((root) => typeof root === "string" && file.startsWith(root + "/"));
  if (index < 0) throw new Error("Native policy is outside its authenticated snapshot");
  const rel = relative(string(roots[index]), file),
    root = context.roots[index] ?? "",
    rebased = resolve(root, rel);
  if (rel === "" || rel.startsWith("..") || relative(root, rebased) !== rel)
    throw new Error("Invalid native source reference");
  return {
    file: rebased,
    address: string(p["address"]),
    enforcement: string(p["enforcement"]),
    result: string(p["result"]),
  };
}

function verifyPlanDisposition(job: Job, payload: Readonly<Record<string, unknown>>): void {
  if (job.phase !== "plan") return;
  const allowed = payload["allows"] === true,
    exit = payload["exitCode"],
    denials = payload["denials"];
  if (
    (allowed && ![0, 2].includes(Number(exit))) ||
    (!allowed && (exit !== 1 || !Array.isArray(denials) || denials.length === 0))
  )
    throw new Error("Native plan lacks a successful disposition or an authenticated policy denial");
}

async function verifyCandidateIdentity(
  context: NativeRun,
  job: Job,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (
    payload["executionId"] !== `${job.id}:${job.fencingToken}:${job.phase}` ||
    typeof payload["allows"] !== "boolean" ||
    !Number.isSafeInteger(payload["exitCode"]) ||
    payload["runtimeSha256"] !== runtimeIdentity(context) ||
    payload["policySnapshotSha256"] !== (await sources(context)).sha256
  )
    throw new Error("Native agent runtime or source identity changed");
}

function auditPolicies(
  audit: string,
  context: NativeRun,
  payload: Readonly<Record<string, unknown>>,
): readonly NativePolicy[] {
  const lines = audit.trimEnd().split("\n");
  if (lines.length > 100000) throw new Error("Native audit exceeds limit");
  const first = object(JSON.parse(lines[0] ?? "{}") as unknown),
    roots = first["roots"];
  if (first["nonce"] !== payload["nonce"] || !Array.isArray(roots) || roots.length !== context.roots.length)
    throw new Error("Native audit snapshot does not match receipt");
  const result: NativePolicy[] = [];
  for (const line of lines) {
    const row = object(JSON.parse(line) as unknown);
    if (row["event"] !== "result") continue;
    const policies = row["policies"];
    if (policies === undefined) continue;
    if (!Array.isArray(policies)) throw new Error("Invalid native policy audit");
    for (const value of policies) result.push(auditPolicy(value, roots, context));
  }
  return result;
}
async function verifyNativeAgentCandidate(context: NativeRun, job: Job, value: unknown): Promise<NativeCandidate> {
  const artifact = object(value),
    receipt = receiptFrom(artifact["receipt"]),
    stage = job.phase === "plan" ? "plan" : "apply";
  const payload = decodeNativeReceipt(
    receipt,
    context.runId,
    context.workspaceId,
    context.evaluation.id,
    context.evaluation.snapshot.fingerprint,
    stage,
  );
  await verifyCandidateIdentity(context, job, payload);
  verifyPlanDisposition(job, payload);
  const audit = string(artifact["audit"]),
    journal = string(artifact["journal"]),
    planJson = string(artifact["planJson"]),
    plan = stage === "plan" ? string(artifact["plan"]) : "";
  if (
    audit.length > LIMIT ||
    journal.length > LIMIT ||
    planJson.length > LIMIT ||
    plan.length > 24 * 1024 * 1024 ||
    hash(audit) !== payload["auditSha256"] ||
    hash(journal) !== payload["journalSha256"] ||
    hash(planJson) !== payload["planJsonSha256"]
  )
    throw new Error("Native agent captured evidence changed");
  if (stage === "plan" && hash(Buffer.from(plan, "base64")) !== payload["planSha256"])
    throw new Error("Native agent plan bytes changed");
  if (stage === "apply") {
    const checkpoint = await nativePlanBytes(context.runId, context.evaluation.id);
    if (checkpoint === null || hash(checkpoint) !== payload["planSha256"])
      throw new Error("Native apply used another saved plan");
  }
  return { context, receipt, payload, plan, planJson, policies: auditPolicies(audit, context, payload) };
}
export async function storeNativeAgentCandidate(
  context: NativeRun,
  job: Job,
  value: unknown,
  current: () => Promise<boolean>,
): Promise<void> {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > 64 * 1024 * 1024) throw new Error("Native agent evidence exceeds limit");
  await verifyNativeAgentCandidate(context, job, value);
  const path = jobFile(context, job, "result"),
    temporary = path + `.${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, await encryptSecret(bytes), { mode: 0o600 });
    if (!(await current())) throw new Error("stale-agent-lease");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
    await revokeNativeAgentToken(context, job);
  }
}
export async function readNativeAgentCandidate(context: NativeRun, job: Job): Promise<NativeCandidate> {
  return verifyNativeAgentCandidate(
    context,
    job,
    JSON.parse(
      await decryptSecret((await readBounded(jobFile(context, job, "result"), 96 * 1024 * 1024)).toString("utf8")),
    ) as unknown,
  );
}
export async function persistNativeAgentPlan(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  candidate: DeepReadonly<NativeCandidate>,
): Promise<void> {
  await persistNativePlan(
    database,
    candidate.context,
    candidate.receipt,
    candidate.plan,
    candidate.planJson,
    candidate.policies,
  );
}
