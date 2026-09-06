import { describe, expect, it } from "bun:test";
import {
  createDependencyManifest,
  createSpdxSbom,
  parseBunLock,
  summarizeDependencyChanges,
} from "../../../scripts/supply-chain-manifest";

const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

function manifestFor(version: string): ReturnType<typeof createDependencyManifest> {
  return createDependencyManifest(
    { packageManager: "bun@1.4.0", overrides: { "example-package": version } },
    [{ path: ".", packageJson: { name: "terrence", dependencies: { "example-package": `^${version}` } } }],
    parseBunLock(`{
      "lockfileVersion": 2,
      "configVersion": 1,
      "packages": {
        "example-package": ["example-package@${version}", "", { "dependencies": {} }, "${integrity}"],
      },
    }`),
    version.replaceAll(".", "").padEnd(64, "0"),
  );
}

describe("dependency supply-chain manifest", () => {
  it("parses Bun trailing commas and records lock integrity metadata", (): void => {
    const manifest = manifestFor("1.2.3");
    expect(manifest.packageManager).toBe("bun@1.4.0");
    expect(manifest.lockfile.lockfileVersion).toBe(2);
    expect(manifest.packages).toEqual([expect.objectContaining({ name: "example-package", version: "1.2.3", integrity })]);
    expect(manifest.workspaces[0]?.dependencies).toEqual([{ name: "example-package", range: "^1.2.3", section: "dependencies" }]);
  });

  it("emits SPDX checksums and reports version changes against a baseline", (): void => {
    const baseline = manifestFor("1.2.2");
    const current = manifestFor("1.2.3");
    const summary = summarizeDependencyChanges(current, baseline, "base-sha");
    expect(summary.changes).toEqual([{ name: "example-package", from: ["1.2.2"], to: ["1.2.3"] }]);
    const sbom = JSON.stringify(createSpdxSbom(current));
    expect(sbom).toContain('"spdxVersion":"SPDX-2.3"');
    expect(sbom).toContain('"algorithm":"SHA512"');
  });
});
