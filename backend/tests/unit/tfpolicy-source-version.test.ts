import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupNativeRun, prepareNativeRun } from "../../src/lib/tfpolicy-native";
import type { WorkspacePolicyEvaluation } from "../../src/lib/workspace-policy-gate";
import type { adminTfpolicyVersions, policySets, policySetVersions } from "../../src/db/schema";

const pin = "a".repeat(64);
const installed = "0.4.0";
const originalProfile = process.env["TERRENCE_TFPOLICY_RUNTIME_PROFILE"];
let temporary = "";
const runIds: string[] = [];
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const catalogRow = (
  version = installed,
  overrides: Readonly<Partial<typeof adminTfpolicyVersions.$inferSelect>> = {},
): typeof adminTfpolicyVersions.$inferSelect => ({
  id: `tool-${version}`,
  version,
  official: false,
  enabled: true,
  beta: false,
  deprecated: false,
  deprecatedReason: null,
  createdAt: 0,
  archs: [
    {
      os: "linux",
      arch: process.arch === "arm64" ? "arm64" : "amd64",
      url: "https://example.invalid/plugin.zip",
      sha: pin,
    },
  ],
  ...overrides,
});
type Source = Readonly<{
  selection?: string | null;
  file?: string;
  nestedFile?: string;
  nested?: boolean;
  wrapped?: boolean;
}>;
async function fixture(
  sources: readonly Source[] = [{}],
  catalog = [catalogRow()],
): Promise<WorkspacePolicyEvaluation> {
  const id = crypto.randomUUID();
  const sets: (typeof policySets.$inferSelect)[] = [];
  const archives = [];
  for (const [index, source] of sources.entries()) {
    const directory = join(temporary, `${id}-${index}`);
    const repository = source.wrapped === true ? join(directory, "repository") : directory;
    const root = source.nested === true ? join(repository, "policies") : repository;
    await mkdir(root, { recursive: true });
    await writeFile(join(repository, "README.md"), "Policy source fixture\n");
    await writeFile(join(root, "allow.policy.hcl"), 'policy "allow" { description = "fixture" }\n');
    if (source.file !== undefined) await writeFile(join(repository, ".tfpolicy-version"), source.file);
    if (source.nestedFile !== undefined) await writeFile(join(root, ".tfpolicy-version"), source.nestedFile);
    const archivePath = `${directory}.tar.gz`;
    const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", directory, "."], { stdout: "pipe", stderr: "pipe" });
    expect(await tar.exited).toBe(0);
    const setId = `set-${id}-${index}`;
    sets.push({
      id: setId,
      orgId: "org-source-version",
      name: setId,
      description: null,
      kind: "tfpolicy",
      global: false,
      overridable: false,
      agentEnabled: true,
      policyToolVersion: source.selection === undefined ? "managed" : source.selection,
      tagMatchLogic: "any",
      policiesPath: source.nested === true ? "policies" : null,
      vcsRepo: null,
      policyUpdatePatterns: [],
      createdAt: 0,
    });
    const version: typeof policySetVersions.$inferSelect = {
      id: `psv-${id}-${index}`,
      policySetId: setId,
      source: "tfe-api",
      status: "ready",
      statusTimestamps: {},
      statusMetadataSchemaVersion: 0,
      ingressAttributes: null,
      error: null,
      archivePath,
      createdAt: 0,
      updatedAt: 0,
    };
    archives.push({ policySetId: setId, version, archiveSha256: hash(await readFile(archivePath)) });
  }
  return {
    id: `eval-${id}`,
    snapshot: {
      fingerprint: pin,
      sets,
      policies: [],
      parameters: [],
      disabledSets: [],
      enforcement: { revision: 0, opa: true, sentinel: true },
      nativeInfo: { sources: archives, catalog, profileDigest: null },
    },
  };
}
function prepare(evaluation: WorkspacePolicyEvaluation) {
  const runId = `run-${crypto.randomUUID()}`;
  runIds.push(runId);
  // This is the production agent preparation boundary. It does not launch the
  // host engine; official-plugin execution is covered in native qualification.
  return prepareNativeRun(
    evaluation,
    runId,
    { id: "ws-source-version", orgId: "org-source-version" },
    "source-version",
    "terraform",
    "1.17.1",
    false,
  );
}
beforeAll(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), "native-source-version-")));
  const pinned = { path: join(temporary, "unused-agent-binary"), sha256: pin };
  const profile = join(temporary, "profile.json");
  await writeFile(
    profile,
    JSON.stringify({
      schemaVersion: 1,
      owner: pinned,
      runtime: {
        engine: pinned,
        runner: pinned,
        supervisor: pinned,
        shim: pinned,
        recorder: pinned,
        plugin: pinned,
        patchSha256: pin,
      },
      pluginVersion: installed,
      catalogSha256: pin,
      cgroupRoot: "/unused-agent-cgroup",
      privateParent: temporary,
    }),
  );
  await chmod(profile, 0o444);
  process.env["TERRENCE_TFPOLICY_RUNTIME_PROFILE"] = profile;
});
afterAll(async () => {
  if (originalProfile === undefined) delete process.env["TERRENCE_TFPOLICY_RUNTIME_PROFILE"];
  else process.env["TERRENCE_TFPOLICY_RUNTIME_PROFILE"] = originalProfile;
  for (const id of runIds) await cleanupNativeRun(id);
  await rm(temporary, { recursive: true, force: true });
});

describe("native source version admission", () => {
  test.each([installed, `${installed}\n`, `${installed}\r\n`, "latest\n"])("managed accepts %j", async (file) => {
    const result = await prepare(await fixture([{ file }]));
    expect(result?.profile.pluginVersion).toBe(installed);
    expect(result?.roots).toHaveLength(1);
  });
  test("reads repository root, including wrapped archives and nested policies-path", async () => {
    const result = await prepare(
      await fixture([{ file: installed, nested: true, nestedFile: "invalid", wrapped: true }]),
    );
    expect(result?.roots[0]).toEndWith("/repository/policies");
    expect(prepare(await fixture([{ nested: true, nestedFile: installed }]))).rejects.toThrow(
      "requires a repository-root",
    );
    expect(prepare(await fixture([{ nested: true, nestedFile: installed, file: "" }]))).rejects.toThrow(
      "one exact version",
    );
  });
  test.each([
    undefined,
    "",
    "\n",
    "managed",
    "0.4",
    "v0.4.0",
    "0.4.0-..",
    "0.4.0-01",
    ">=0.4.0",
    "0.4.0\n0.4.0",
    "0.4.0\n\n",
    "0.4.0 # comment",
    " 0.4.0",
    "0.4.0\u0000",
  ])("rejects missing or malformed managed source %j", async (file) => {
    expect(prepare(await fixture([file === undefined ? {} : { file }]))).rejects.toThrow(
      file === undefined ? "requires a repository-root" : "one exact version",
    );
  });
  test("rejects bounded adversarial prerelease input without ambiguous regex backtracking", async () => {
    // Below the 1024-byte file bound. This shape triggered CodeQL's warning
    // about the former nested regex; only exercise the replacement parser.
    const file = `0.0.0-0.${"--.".repeat(300)}!`;
    expect(prepare(await fixture([{ file }]))).rejects.toThrow("one exact version");
  });
  test.each(["0.4.0-alpha.1", "0.4.0-0.a-1", "0.4.0---", "0.4.0-01a"])(
    "valid prerelease %j reaches immutable version-pin validation",
    async (file) => {
      expect(prepare(await fixture([{ file }]))).rejects.toThrow("installed pinned plugin");
    },
  );
  test("managed latest uses only enabled stable non-deprecated catalog entries", async () => {
    const catalog = [
      catalogRow(),
      catalogRow("0.3.0"),
      catalogRow("9.0.0", { enabled: false }),
      catalogRow("8.0.0", { beta: true }),
      catalogRow("7.0.0", { deprecated: true }),
      catalogRow("6.0.0-rc1"),
    ];
    expect((await prepare(await fixture([{ file: "latest" }], catalog)))?.profile.pluginVersion).toBe(installed);
    expect(prepare(await fixture([{ file: "latest" }], [catalogRow(), catalogRow("0.10.0")]))).rejects.toThrow(
      "installed pinned plugin",
    );
    expect(prepare(await fixture([{ file: "latest" }], [catalogRow(installed, { beta: true })]))).rejects.toThrow(
      "installed pinned plugin",
    );
  });
  test("missing or disabled selected versions never fall back", async () => {
    expect(prepare(await fixture([{ file: "0.3.0" }]))).rejects.toThrow("installed pinned plugin");
    expect(prepare(await fixture([{ file: installed }], [catalogRow(installed, { enabled: false })]))).rejects.toThrow(
      "enabled version catalog",
    );
    expect(
      prepare(await fixture([{ file: "0.3.0" }], [catalogRow(), catalogRow("0.3.0", { enabled: false })])),
    ).rejects.toThrow("installed pinned plugin");
  });
  test.each([installed, "latest", null])("API selection %j does not inherit the repository file", async (selection) => {
    expect((await prepare(await fixture([{ selection, file: "invalid\nconflicting" }])))?.roots).toHaveLength(1);
    expect((await prepare(await fixture([{ selection }])))?.roots).toHaveLength(1);
  });
  test("latest API selection cannot be downgraded by the repository file", async () => {
    expect(
      prepare(await fixture([{ selection: "latest", file: installed }], [catalogRow(), catalogRow("0.10.0")])),
    ).rejects.toThrow("installed pinned plugin");
  });
  test("source archive and catalog pins remain mandatory", async () => {
    const evaluation = await fixture([{ file: installed }]);
    const archive = evaluation.snapshot.nativeInfo?.sources[0]?.version?.archivePath;
    if (!archive) throw new Error("Missing fixture archive");
    await writeFile(archive, "changed");
    expect(prepare(evaluation)).rejects.toThrow("source changed");
    expect(prepare(await fixture([{ file: installed }], [catalogRow(installed, { archs: [] })]))).rejects.toThrow(
      "enabled version catalog",
    );
  });
  test("conflicting source versions cannot select a different binary for the run", async () => {
    expect(
      prepare(await fixture([{ file: installed }, { file: "0.3.0" }], [catalogRow(), catalogRow("0.3.0")])),
    ).rejects.toThrow("installed pinned plugin");
  });
});
