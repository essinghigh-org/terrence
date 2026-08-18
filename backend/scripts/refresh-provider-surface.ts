#!/usr/bin/env bun
/**
 * Regenerate the provider-surface catalog from the latest hashicorp/tfe release.
 *
 * The catalog (backend/src/data/provider_surface.json and its tests/e2e copy)
 * is what the admin compatibility dashboard serves. It is hand-curated today;
 * this script regenerates it deterministically:
 *
 *   1. Resolve the target version: TFE_PROVIDER_VERSION env, else the latest
 *      stable release from the GitHub API.
 *   2. If the target equals the catalog version, exit 0 without touching files.
 *   3. Otherwise run `terraform init` + `terraform providers schema -json`
 *      against a temp config pinning the target version, and diff the schema
 *      resource/data-source names against the catalog.
 *   4. Existing names keep their status (covered / planned / backend-gap /
 *      admin); NEW names are marked backend-gap; REMOVED names are dropped.
 *   5. Rewrite both catalog copies and print a summary.
 *
 * Usage:
 *   bun backend/scripts/refresh-provider-surface.ts            # latest release
 *   TFE_PROVIDER_VERSION=0.79.0 bun backend/scripts/...       # pinned override
 *   TERRAFORM_BIN=tofu bun backend/scripts/...                # alternate CLI
 *
 * Exit codes: 0 = current or refreshed; 1 = resolution/schema failure.
 * The caller (workflow or human) diffs the JSON to decide whether to commit.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fetchLatestTfeProviderVersion } from "../src/lib/provider-version";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const SURFACE_SRC = join(REPO_ROOT, "backend", "src", "data", "provider_surface.json");
const SURFACE_E2E = join(REPO_ROOT, "backend", "tests", "e2e", "provider_surface.json");
const PLUGIN_CACHE = join(REPO_ROOT, "backend", "storage", "e2e-plugin-cache");
const TERRAFORM_BIN = process.env.TERRAFORM_BIN ?? "terraform";

type SurfaceEntry = Readonly<{ name: string; status: string }>;

type Surface = Readonly<{
  _comment: string;
  provider: string;
  resource_count: number;
  data_source_count: number;
  resources_covered: number;
  data_sources_covered: number;
  resources: SurfaceEntry[];
  data_sources: SurfaceEntry[];
}>;

function loadSurface(path: string): Surface {
  return JSON.parse(readFileSync(path, "utf8")) as Surface;
}

function catalogVersion(surface: Surface): string | null {
  const match = /v(\d+\.\d+\.\d+)/.exec(surface.provider);
  return match?.[1] ?? null;
}

async function resolveTargetVersion(current: string | null): Promise<string> {
  const pinned = process.env.TFE_PROVIDER_VERSION;
  if (pinned !== undefined && pinned !== "") return pinned;
  const latest = await fetchLatestTfeProviderVersion();
  if (latest === null) {
    throw new Error(
      "Could not resolve the latest provider version (GitHub API unavailable). "
      + `Current catalog: ${current ?? "unknown"}. Set TFE_PROVIDER_VERSION to pin.`,
    );
  }
  return latest;
}

function generateSchema(version: string): { resources: string[]; dataSources: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "provider-surface-"));
  try {
    writeFileSync(join(dir, "main.tf"), [
      'terraform {',
      '  required_providers {',
      `    tfe = { source = "hashicorp/tfe", version = "= ${version}" }`,
      '  }',
      '}',
      '',
    ].join("\n"));
    const env = {
      ...process.env,
      TF_IN_AUTOMATION: "1",
      TF_PLUGIN_CACHE_DIR: PLUGIN_CACHE,
    };
    const init = spawnSync(TERRAFORM_BIN, ["init", "-input=false", "-no-color"], {
      cwd: dir, env, encoding: "utf8", timeout: 120_000,
    });
    if (init.status !== 0) {
      throw new Error(`terraform init failed (exit ${init.status}):\n${init.stderr ?? init.stdout}`);
    }
    const schema = spawnSync(TERRAFORM_BIN, ["providers", "schema", "-json"], {
      cwd: dir, env, encoding: "utf8", timeout: 120_000,
    });
    if (schema.status !== 0) {
      throw new Error(`terraform providers schema failed (exit ${schema.status}):\n${schema.stderr ?? schema.stdout}`);
    }
    const parsed = JSON.parse(schema.stdout) as { provider_schemas?: Record<string, { resource_schemas?: Record<string, unknown>; data_source_schemas?: Record<string, unknown> }> };
    const address = Object.keys(parsed.provider_schemas ?? {}).find((key): boolean => key.endsWith("/hashicorp/tfe"));
    const providerSchema = address !== undefined ? parsed.provider_schemas?.[address] : undefined;
    if (providerSchema === undefined) {
      throw new Error("The generated schema does not contain a hashicorp/tfe provider entry.");
    }
    return {
      resources: Object.keys(providerSchema.resource_schemas ?? {}).sort(),
      dataSources: Object.keys(providerSchema.data_source_schemas ?? {}).sort(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mergeStatuses(existing: SurfaceEntry[], names: string[]): SurfaceEntry[] {
  const byName = new Map(existing.map((entry): [string, string] => [entry.name, entry.status]));
  return names.map((name): SurfaceEntry => ({ name, status: byName.get(name) ?? "backend-gap" }));
}

function commentFor(version: string): string {
  return `Authoritative hashicorp/tfe v${version} provider surface, generated from \`terraform providers schema -json\` by backend/scripts/refresh-provider-surface.ts. Status values: covered (exercised by provider_e2e E2E), planned (backend routes exist, not yet in E2E), backend-gap (backend lacks routes), admin (requires site-admin auth, not reachable with org token).`;
}

async function main(): Promise<void> {
  const existing = loadSurface(SURFACE_SRC);
  const current = catalogVersion(existing);
  const target = await resolveTargetVersion(current);
  if (target === current) {
    console.log(`Provider surface already current (v${target}).`);
    process.exit(0);
  }

  const { resources, dataSources } = generateSchema(target);
  const mergedResources = mergeStatuses(existing.resources, resources);
  const mergedDataSources = mergeStatuses(existing.data_sources, dataSources);
  const next: Surface = {
    _comment: commentFor(target),
    provider: `hashicorp/tfe v${target}`,
    resource_count: mergedResources.length,
    data_source_count: mergedDataSources.length,
    resources_covered: mergedResources.filter((entry): boolean => entry.status === "covered").length,
    data_sources_covered: mergedDataSources.filter((entry): boolean => entry.status === "covered").length,
    resources: mergedResources,
    data_sources: mergedDataSources,
  };

  const added = resources.filter((name): boolean => !existing.resources.some((entry): boolean => entry.name === name));
  const removed = existing.resources.filter((entry): boolean => !resources.includes(entry.name)).map((entry): string => entry.name);

  const payload = `${JSON.stringify(next, null, 2)}\n`;
  writeFileSync(SURFACE_SRC, payload);
  writeFileSync(SURFACE_E2E, payload);
  console.log(`Refreshed provider surface: v${current ?? "?"} -> v${target}`);
  console.log(`Resources: ${existing.resource_count} -> ${next.resource_count} (covered ${next.resources_covered})`);
  console.log(`Data sources: ${existing.data_source_count} -> ${next.data_source_count} (covered ${next.data_sources_covered})`);
  if (added.length > 0) console.log(`Added (backend-gap): ${added.join(", ")}`);
  if (removed.length > 0) console.log(`Removed: ${removed.join(", ")}`);
}

main();
