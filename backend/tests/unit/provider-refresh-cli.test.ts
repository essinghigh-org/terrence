import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { schemaHash } from "../../scripts/lib/provider-drift";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(failComparison = false) {
  const root = mkdtempSync(join(tmpdir(), "provider-refresh-test-"));
  roots.push(root);
  const backend = join(root, "backend");
  mkdirSync(join(backend, "src/data"), { recursive: true });
  mkdirSync(join(backend, "tests/e2e"), { recursive: true });
  cpSync(resolve(import.meta.dir, "../../scripts"), join(backend, "scripts"), { recursive: true });
  cpSync(resolve(import.meta.dir, "../../src/lib"), join(backend, "src/lib"), { recursive: true });
  const before = { block: { attributes: { kind: { type: "string", optional: true } } } };
  const after = {
    block: {
      attributes: { kind: { type: "string", optional: true }, tfpolicy_version: { type: "string", optional: true } },
    },
  };
  const surface = {
    _comment: "test",
    provider: "hashicorp/tfe v0.82.0",
    resource_count: 1,
    data_source_count: 0,
    resources_covered: 1,
    data_sources_covered: 0,
    resources: [{ name: "tfe_policy_set", status: "covered", schema_hash: schemaHash(before) }],
    data_sources: [],
  };
  const catalog = join(backend, "src/data/provider_surface.json");
  writeFileSync(catalog, JSON.stringify(surface));
  writeFileSync(join(backend, "tests/e2e/provider_surface.json"), JSON.stringify(surface));
  const terraform = join(root, "terraform");
  writeFileSync(
    terraform,
    `#!${process.execPath}\nimport {readFileSync} from 'node:fs';\nif(process.argv[2] === 'providers') {\nconst target=readFileSync('main.tf','utf8').includes('0.83.0');\nconsole.log(JSON.stringify({provider_schemas:{'registry.terraform.io/hashicorp/tfe':{resource_schemas:{tfe_policy_set:target?${JSON.stringify(after)}:${JSON.stringify(before)}},data_source_schemas:{}}}}));\n}\n`,
  );
  chmodSync(terraform, 0o755);
  const preload = join(root, "fetch.ts");
  writeFileSync(
    preload,
    `globalThis.fetch = async (url) => { if(!String(url).endsWith('/compare/v0.82.0...v0.83.0')) throw new Error('Unexpected request '+url); return new Response(JSON.stringify({status:'ahead',files:[{filename:'internal/provider/resource_tfe_policy_set.go',status:'modified'}]}), {status:${failComparison ? 503 : 200}}); };`,
  );
  const result = spawnSync(
    process.execPath,
    ["--preload", preload, join(backend, "scripts/refresh-provider-surface.ts")],
    {
      env: { ...process.env, TERRAFORM_BIN: terraform, TFE_PROVIDER_VERSION: "0.83.0" },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  return { root, backend, catalog, surface, result };
}

test("refresh CLI writes synchronized catalogs and a review of existing-schema and source changes", () => {
  const { backend, catalog, result } = fixture();
  expect(result.status, result.stderr).toBe(0);
  const updated = JSON.parse(readFileSync(catalog, "utf8"));
  expect(updated.provider).toBe("hashicorp/tfe v0.83.0");
  expect(updated.resources[0].status).toBe("covered"); // Inventory only, not a compatibility claim.
  expect(readFileSync(catalog, "utf8")).toBe(readFileSync(join(backend, "tests/e2e/provider_surface.json"), "utf8"));
  const review = readFileSync(join(backend, "src/data/provider_refresh_review.md"), "utf8");
  expect(review).toContain("Schema changed: `tfe_policy_set`");
  expect(review).toContain("tfpolicy_version");
  expect(review).toContain("internal/provider/resource_tfe_policy_set.go");
});

test("refresh CLI leaves catalogs untouched when upstream source comparison is unavailable", () => {
  const { backend, catalog, surface, result } = fixture(true);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("refusing an incomplete refresh");
  expect(JSON.parse(readFileSync(catalog, "utf8"))).toEqual(surface);
  expect(existsSync(join(backend, "src/data/provider_refresh_review.md"))).toBe(false);
});
