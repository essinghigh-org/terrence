import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { moduleTestRuns } from "../db/schema";
import {
  moduleTestIdentityEnvironment,
  type CredentialProvider,
} from "./workload-identity";
import {
  runModuleTest,
  writeModuleTestResultFile,
  type ModuleTestConfiguration,
} from "./module-tests";

type SupervisorInput = Readonly<{
  runId: string;
  versionId: string;
  archivePath: string;
  resultPath: string;
  configuration: ModuleTestConfiguration;
  organizationId: string;
  organizationName: string;
  moduleName: string;
  ttlSeconds: number;
  oidcProvider: CredentialProvider | null;
  oidcValues: Record<string, unknown>;
}>;

function inputPath(): string {
  const path = process.argv[2];
  if (typeof path !== "string" || path === "") throw new Error("module-test supervisor input is missing");
  return path;
}

const input = JSON.parse(await readFile(inputPath(), "utf8")) as SupervisorInput;
const stat = await readFile(`/proc/${process.pid}/stat`, "utf8").catch((): string => "");
const startTime = stat === "" ? null : stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19] ?? null;
await writeFile(join(dirname(inputPath()), "supervisor.pid"), JSON.stringify({ pid: process.pid, startTime }), { mode: 0o600 });
await db.update(moduleTestRuns).set({
  executionPid: process.pid,
  executionStartedAt: Date.now(),
  executionStage: "subprocess",
  executionDirectory: inputPath().slice(0, inputPath().lastIndexOf("/")),
  executionResultPath: input.resultPath,
  updatedAt: Date.now(),
}).where(and(eq(moduleTestRuns.id, input.runId), eq(moduleTestRuns.status, "running"), isNull(moduleTestRuns.executionPid)));
const issuedTokenIds: string[] = [];
const result = await runModuleTest(
  input.versionId,
  input.archivePath,
  input.configuration,
  undefined,
  async (stagingDirectory): Promise<Readonly<Record<string, string>>> => {
    if (input.oidcProvider === null) return {};
    const identity = await moduleTestIdentityEnvironment({
      organizationId: input.organizationId,
      organizationName: input.organizationName,
      moduleName: input.moduleName,
      runId: input.runId,
      ttlSeconds: input.ttlSeconds,
    }, { provider: input.oidcProvider, values: input.oidcValues }, stagingDirectory);
    issuedTokenIds.push(identity.token.jti);
    await db.update(moduleTestRuns).set({
      oidcTokenGeneratedAt: identity.token.generatedAt,
      oidcTokenExpiresAt: identity.token.expiresAt,
      executionTokenIds: [...issuedTokenIds],
      updatedAt: Date.now(),
    }).where(and(eq(moduleTestRuns.id, input.runId), eq(moduleTestRuns.status, "running")));
    return identity.environment;
  },
);
await writeModuleTestResultFile(input.resultPath, result);
