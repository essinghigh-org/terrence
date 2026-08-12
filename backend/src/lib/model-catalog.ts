import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Provider/model catalog for the AI plan explainer (kanban 21.2 UI upgrade).
// Sources the provider dropdown + model picker from the models.dev static
// catalog (https://models.dev/api.json) — 183 providers, per-model modalities
// — fetched in the background and cached for MODEL_CATALOG_TTL_MS (6h).
// Additive convenience only: the explainer itself still talks to whatever
// endpoint-url the admin configured; this lib never changes run behavior.

export const MODEL_CATALOG_URL = "https://models.dev/api.json";
export const MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6h, per user request
export const MODEL_CATALOG_FETCH_TIMEOUT_MS = 30_000;

/** Synthetic provider id for arbitrary OpenAI-compatible endpoints. Always
 * listed first in the admin dropdown (the default choice) and usable even
 * when the models.dev catalog is unreachable. */
export const CUSTOM_PROVIDER_ID = "custom";

const CUSTOM_PROVIDER: CatalogProvider = Object.freeze({
  id: CUSTOM_PROVIDER_ID,
  name: "OpenAI Compatible (Custom)",
  baseUrl: null,
  models: [],
});

const catalogDirectory = resolve(
  process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"),
  "model-catalog",
);
const catalogCacheFile = join(catalogDirectory, "catalog.json");

/** One catalog provider: id, display name, OpenAI-compatible base URL (when
 * models.dev publishes one), and its text-output-capable models. */
export type CatalogProvider = Readonly<{
  id: string;
  name: string;
  baseUrl: string | null;
  models: ReadonlyArray<Readonly<{
    id: string;
    name: string;
    reasoning: boolean;
    context: number | null;
  }>>;
}>;

export type ModelCatalog = Readonly<{
  fetchedAt: number;
  providers: CatalogProvider[];
}>;

// Curated base URLs for providers models.dev knows but does not publish an
// OpenAI-compatible `api` base URL for (majors; the catalog only lists `api`
// for providers that expose a documented OpenAI-compatible endpoint).
const CURATED_BASE_URLS: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  togetherai: "https://api.together.xyz/v1",
  cohere: "https://api.cohere.com/v1",
  perplexity: "https://api.perplexity.ai",
  cerebras: "https://api.cerebras.ai/v1",
  deepseek: "https://api.deepseek.com",
  nvidia: "https://integrate.api.nvidia.com/v1",
};

let inMemoryCache: ModelCatalog | null = null;

function asObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

/** True when the model can emit text (modalities.output includes "text").
 * Models with no modalities metadata are assumed text-capable (default
 * behavior for the curated majors). */
function canOutputText(model: Readonly<Record<string, unknown>>): boolean {
  const modalities = asObject(model.modalities);
  if (modalities === undefined) return true;
  const output = modalities.output;
  return Array.isArray(output) && output.includes("text");
}

/** Parse the raw models.dev catalog JSON into the trimmed shape. Unknown or
 * malformed entries are skipped; the whole parse degrades to [] on structural
 * corruption rather than throwing (cold start, never crash the API). */
export function parseModelCatalog(raw: string): CatalogProvider[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const root = asObject(parsed);
  if (root === undefined) return [];
  const providers: CatalogProvider[] = [];
  for (const [id, rawProvider] of Object.entries(root)) {
    const provider = asObject(rawProvider);
    if (provider === undefined) continue;
    const rawModels = asObject(provider.models);
    if (rawModels === undefined) continue;
    type ModelEntry = { id: string; name: string; reasoning: boolean; context: number | null };
    const models: ModelEntry[] = [];
    for (const [modelId, rawModel] of Object.entries(rawModels)) {
      const model = asObject(rawModel);
      if (model === undefined) continue;
      if (!canOutputText(model)) continue;
      const contextRaw = asObject(model.limit)?.context;
      models.push({
        id: modelId,
        name: typeof model.name === "string" && model.name !== "" ? model.name : modelId,
        reasoning: model.reasoning === true,
        context: typeof contextRaw === "number" && Number.isFinite(contextRaw) && contextRaw > 0 ? contextRaw : null,
      });
    }
    if (models.length === 0) continue;
    const baseUrl = typeof provider.api === "string" && provider.api !== ""
      ? provider.api
      : (CURATED_BASE_URLS[id] ?? null);
    providers.push({
      id,
      name: typeof provider.name === "string" && provider.name !== "" ? provider.name : id,
      baseUrl,
      models: models.sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  return providers.sort((a, b) => a.name.localeCompare(b.name));
}

function isFresh(catalog: ModelCatalog, now: number): boolean {
  return Number.isFinite(catalog.fetchedAt)
    && catalog.fetchedAt + MODEL_CATALOG_TTL_MS > now;
}

/** Read the on-disk cache. Missing/unreadable/corrupt files degrade to null. */
export async function loadModelCatalogFile(): Promise<ModelCatalog | null> {
  try {
    const raw = await readFile(catalogCacheFile, "utf8");
    const value = JSON.parse(raw) as unknown;
    const obj = asObject(value);
    if (obj === undefined || typeof obj.fetchedAt !== "number" || !Array.isArray(obj.providers)) return null;
    return { fetchedAt: obj.fetchedAt, providers: obj.providers as CatalogProvider[] };
  } catch {
    return null;
  }
}

/** Fetch the catalog from models.dev. Returns null on any network/parse
 * failure so callers can fall back to the stale on-disk cache. */
export async function fetchModelCatalogRemote(): Promise<ModelCatalog | null> {
  try {
    const response = await fetch(MODEL_CATALOG_URL, {
      signal: AbortSignal.timeout(MODEL_CATALOG_FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const raw = await response.text();
    const providers = parseModelCatalog(raw);
    if (providers.length === 0) return null;
    return { fetchedAt: Date.now(), providers };
  } catch {
    return null;
  }
}

async function persistCatalog(catalog: ModelCatalog): Promise<void> {
  try {
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(catalogCacheFile, JSON.stringify(catalog), "utf8");
  } catch {
    // Cache write failure is non-fatal; in-memory copy still serves.
  }
}

/** Return the catalog, refreshing from the network when the cache is stale
 * or absent. Never throws: on fetch failure it serves the stale on-disk
 * cache, then the in-memory cache, then an empty catalog (the UI falls back
 * to free-text entry). */
export async function getModelCatalog(now: number = Date.now()): Promise<ModelCatalog> {
  const inMemory = inMemoryCache;
  if (inMemory !== null && isFresh(inMemory, now)) return inMemory;
  const onDisk = await loadModelCatalogFile();
  if (onDisk !== null && isFresh(onDisk, now)) {
    inMemoryCache = onDisk;
    return onDisk;
  }
  const remote = await fetchModelCatalogRemote();
  if (remote !== null) {
    inMemoryCache = remote;
    void persistCatalog(remote);
    return remote;
  }
  if (onDisk !== null) {
    inMemoryCache = onDisk; // stale but usable
    return onDisk;
  }
  if (inMemory !== null) return inMemory;
  return { fetchedAt: 0, providers: [] };
}

/** Providers for the admin dropdown: id, name, base URL (when known), and
 * text-capable model count. Sorted by name, with the synthetic
 * "OpenAI Compatible (Custom)" entry pinned first (it is the default). */
export async function listCatalogProviders(now: number = Date.now()): Promise<ReadonlyArray<Readonly<{
  id: string;
  name: string;
  baseUrl: string | null;
  modelCount: number;
}>>> {
  const catalog = await getModelCatalog(now);
  const rows = catalog.providers
    .filter((provider) => provider.id !== CUSTOM_PROVIDER_ID)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      modelCount: provider.models.length,
    }));
  return [{ id: CUSTOM_PROVIDER_ID, name: CUSTOM_PROVIDER.name, baseUrl: null, modelCount: 0 }, ...rows];
}

/** Text-output-capable models for one provider. The synthetic custom
 * provider always resolves (to zero catalog models: the admin types the
 * model id); unknown provider ids return undefined. */
export async function getCatalogProviderModels(
  providerId: string,
  now: number = Date.now(),
): Promise<CatalogProvider | undefined> {
  if (providerId === CUSTOM_PROVIDER_ID) return CUSTOM_PROVIDER;
  const catalog = await getModelCatalog(now);
  return catalog.providers.find((provider) => provider.id === providerId);
}

/** Test hook: clear the in-memory cache (and optionally seed it). */
export function _resetModelCatalogCache(catalog: ModelCatalog | null = null): void {
  inMemoryCache = catalog;
}

export { catalogCacheFile, catalogDirectory };
