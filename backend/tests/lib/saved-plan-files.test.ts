import { afterEach, beforeEach, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfinedSavedPlan, writeConfinedSavedPlan } from "../../src/lib/saved-plan-files";

let root = "";

beforeEach(async (): Promise<void> => {
  root = await mkdtemp(join(tmpdir(), "terrence-plan-files-"));
});
afterEach(async (): Promise<void> => {
  await rm(root, { recursive: true, force: true });
});

test("publishes and reads a private saved plan in a nested execution directory", async (): Promise<void> => {
  const directory = join(root, "module", "configuration");
  await writeConfinedSavedPlan(root, directory, Buffer.from("saved plan bytes"));
  expect((await readConfinedSavedPlan(root, directory)).toString()).toBe("saved plan bytes");
  expect(await readdir(directory)).toEqual(["tfplan"]);
});

test("reads reject symlinked, multiply linked and nonregular plan entries", async (): Promise<void> => {
  await writeFile(join(root, "fixture"), "fixture bytes");
  const path = join(root, "tfplan");
  await symlink("fixture", path);
  expect(await readConfinedSavedPlan(root, root).catch((error: unknown): unknown => error)).toBeInstanceOf(Error);
  await rm(path);
  await link(join(root, "fixture"), path);
  expect(await readConfinedSavedPlan(root, root).catch((error: unknown): unknown => error)).toBeInstanceOf(Error);
  await rm(path);
  await mkdir(path);
  expect(await readConfinedSavedPlan(root, root).catch((error: unknown): unknown => error)).toBeInstanceOf(Error);
});

test("directory traversal rejects symlink components and paths outside the run root", async (): Promise<void> => {
  const directory = join(root, "module");
  await mkdir(directory);
  await writeFile(join(directory, "tfplan"), "fixture bytes");
  await symlink("module", join(root, "alias"));
  expect(
    await readConfinedSavedPlan(root, join(root, "alias")).catch((error: unknown): unknown => error),
  ).toBeInstanceOf(Error);
  expect(
    await writeConfinedSavedPlan(root, join(root, "alias"), Buffer.from("plan")).catch(
      (error: unknown): unknown => error,
    ),
  ).toBeInstanceOf(Error);
  expect(
    await writeConfinedSavedPlan(root, join(root, ".."), Buffer.from("plan")).catch((error: unknown): unknown => error),
  ).toBeInstanceOf(Error);
  expect(await readFile(join(directory, "tfplan"), "utf8")).toBe("fixture bytes");
});

test("restoration replaces an existing entry without opening its linked destination", async (): Promise<void> => {
  await writeFile(join(root, "fixture"), "fixture bytes");
  await symlink("fixture", join(root, "tfplan"));
  await writeConfinedSavedPlan(root, root, Buffer.from("restored plan"));
  expect(await readFile(join(root, "fixture"), "utf8")).toBe("fixture bytes");
  expect((await readConfinedSavedPlan(root, root)).toString()).toBe("restored plan");
  expect((await readdir(root)).sort()).toEqual(["fixture", "tfplan"]);
});
