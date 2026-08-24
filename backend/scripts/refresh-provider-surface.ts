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
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fetchLatestTfeProviderVersion } from "../src/lib/provider-version";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const SURFACE_SRC = join(REPO_ROOT, "backend", "src", "data", "provider_surface.json");
const SURFACE_E2E = join(REPO_ROOT, "backend", "tests", "e2e", "provider_surface.json");
const PLUGIN_CACHE = join(REPO_ROOT, "backend", "storage", "e2e-plugin-cache");
const TERRAFORM_BIN = process.env.TERRAFORM_BIN ?? "terraform";

type SurfaceEntry = Readonly<{ name: string; status: string; schema_hash?: string }>;

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

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function schemaHash(schema: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(schema))).digest("hex");
}

function generateSchema(version: string): { resources: Record<string, unknown>; dataSources: Record<string, unknown> } {
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
      resources: providerSchema.resource_schemas ?? {},
      dataSources: providerSchema.data_source_schemas ?? {},
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mergeStatuses(existing: SurfaceEntry[], schemas: Record<string, unknown>): SurfaceEntry[] {
  const byName = new Map(existing.map((entry): [string, string] => [entry.name, entry.status]));
  return Object.keys(schemas).sort().map((name): SurfaceEntry => ({
    name,
    status: byName.get(name) ?? "backend-gap",
    schema_hash: schemaHash(schemas[name]),
  }));
}

function schemaHashesMatch(surface: Surface, resources: Record<string, unknown>, dataSources: Record<string, unknown>): boolean {
  const matches = (entry: SurfaceEntry, schemas: Record<string, unknown>): boolean =>
    Object.prototype.hasOwnProperty.call(schemas, entry.name) && schemaHash(schemas[entry.name]) === entry.schema_hash;
  if (surface.resources.length !== Object.keys(resources).length) return false;
  if (surface.data_sources.length !== Object.keys(dataSources).length) return false;
  return surface.resources.every((entry): boolean => matches(entry, resources))
    && surface.data_sources.every((entry): boolean => matches(entry, dataSources));
}

function commentFor(version: string): string {
  return `Authoritative hashicorp/tfe v${version} provider surface, generated from \`terraform providers schema -json\` by backend/scripts/refresh-provider-surface.ts. Each entry includes a SHA-256 schema_hash over its full resource/data-source schema. Status values: covered (exercised by provider_e2e E2E), planned (backend routes exist, not yet in E2E), backend-gap (backend lacks routes), admin (requires site-admin auth, not reachable with org token).`;
}

async function main(): Promise<void> {
  const existing = loadSurface(SURFACE_SRC);
  const current = catalogVersion(existing);
  const target = await resolveTargetVersion(current);
  const hasSchemaHashes = [...existing.resources, ...existing.data_sources].every((entry): boolean =>
    typeof entry.schema_hash === "string" && /^[0-9a-f]{64}$/i.test(entry.schema_hash),
  );
  let generated: { resources: Record<string, unknown>; dataSources: Record<string, unknown> } | undefined;
  if (target === current && hasSchemaHashes && process.env.TERRENCE_PROVIDER_SURFACE_FORCE !== "1") {
    generated = generateSchema(target);
    if (schemaHashesMatch(existing, generated.resources, generated.dataSources)) {
      console.log(`Provider surface already current (v${target}).`);
      process.exit(0);
    }
  }

  const { resources, dataSources } = generated ?? generateSchema(target);
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

  const resourceNames = Object.keys(resources);
  const dataSourceNames = Object.keys(dataSources);
  const added = resourceNames.filter((name): boolean => !existing.resources.some((entry): boolean => entry.name === name));
  const removed = existing.resources.filter((entry): boolean => !resourceNames.includes(entry.name)).map((entry): string => entry.name);
  const addedDataSources = dataSourceNames.filter((name): boolean => !existing.data_sources.some((entry): boolean => entry.name === name));
  const removedDataSources = existing.data_sources.filter((entry): boolean => !dataSourceNames.includes(entry.name)).map((entry): string => entry.name);

  const payload = `${JSON.stringify(next, null, 2)}\n`;
  writeFileSync(SURFACE_SRC, payload);
  writeFileSync(SURFACE_E2E, payload);
  console.log(`Refreshed provider surface: v${current ?? "?"} -> v${target}`);
  console.log(`Resources: ${existing.resource_count} -> ${next.resource_count} (covered ${next.resources_covered})`);
  console.log(`Data sources: ${existing.data_source_count} -> ${next.data_source_count} (covered ${next.data_sources_covered})`);
  if (added.length > 0) console.log(`Added (backend-gap): ${added.join(", ")}`);
  if (removed.length > 0) console.log(`Removed: ${removed.join(", ")}`);
  if (addedDataSources.length > 0) console.log(`Added data sources (backend-gap): ${addedDataSources.join(", ")}`);
  if (removedDataSources.length > 0) console.log(`Removed data sources: ${removedDataSources.join(", ")}`);
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
