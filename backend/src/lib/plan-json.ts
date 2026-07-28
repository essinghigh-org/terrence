import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const planJsonDirectory = resolve(
  process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"),
  "plan-json",
);

export type PlanJson = Readonly<Record<string, unknown>>;

function artifactPath(runId: string): string {
  return join(planJsonDirectory, `${runId}.json`);
}

export async function writePlanJsonArtifact(runId: string, planJson: PlanJson): Promise<void> {
  await mkdir(planJsonDirectory, { recursive: true, mode: 0o700 });
  const target = artifactPath(runId);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(planJson), { mode: 0o600 });
  await rename(temporary, target);
}

export async function readPlanJsonArtifact(runId: string): Promise<PlanJson | undefined> {
  try {
    const parsed = JSON.parse(await readFile(artifactPath(runId), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Stored plan JSON must be an object.");
    }
    return parsed as PlanJson;
  } catch (error: unknown) {
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "ENOENT"
    ) return undefined;
    throw error;
  }
}

export async function deletePlanJsonArtifact(runId: string): Promise<boolean> {
  try {
    await rm(artifactPath(runId));
    return true;
  } catch (error: unknown) {
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "ENOENT"
    ) return false;
    throw error;
  }
}
