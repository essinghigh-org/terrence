import { describe, expect, it } from "bun:test";
import {
  _resetModelCatalogCache,
  MODEL_CATALOG_TTL_MS,
  getCatalogProviderModels,
  getModelCatalog,
  listCatalogProviders,
  parseModelCatalog,
} from "../../src/lib/model-catalog";

// A representative slice of the models.dev catalog shape: providers with and
// without an `api` base URL, models with and without text output.
const SAMPLE = JSON.stringify({
  "openrouter": {
    id: "openrouter",
    name: "OpenRouter",
    api: "https://openrouter.ai/api/v1",
    models: {
      "deepcogito/cogito-v2.1-671b": {
        id: "deepcogito/cogito-v2.1-671b",
        name: "Cogito v2.1 671B",
        reasoning: true,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 128000, output: 128000 },
      },
      "some/image-model": {
        id: "some/image-model",
        name: "Image Only",
        modalities: { input: ["text"], output: ["image"] },
        limit: { context: 1000 },
      },
    },
  },
  "openai": {
    id: "openai",
    name: "OpenAI",
    api: null,
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 128000 },
      },
      "gpt-4o-mini": {
        id: "gpt-4o-mini",
        name: "GPT-4o mini",
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 128000 },
      },
    },
  },
  "nostalgiacorp": {
    id: "nostalgiacorp",
    name: "Nostalgia Corp",
    api: null,
    models: {
      "retro-1": { id: "retro-1", name: "Retro 1", modalities: { input: ["text"], output: ["text"] } },
    },
  },
});

describe("parseModelCatalog", () => {
  it("keeps only text-output-capable models", () => {
    const providers = parseModelCatalog(SAMPLE);
    const openrouter = providers.find((p) => p.id === "openrouter");
    expect(openrouter).toBeDefined();
    const ids = openrouter?.models.map((m) => m.id) ?? [];
    expect(ids).toContain("deepcogito/cogito-v2.1-671b");
    expect(ids).not.toContain("some/image-model"); // image-only output filtered
  });

  it("fills curated base URLs for majors missing an api field", () => {
    const providers = parseModelCatalog(SAMPLE);
    const openai = providers.find((p) => p.id === "openai");
    expect(openai?.baseUrl).toBe("https://api.openai.com/v1");
    const openrouter = providers.find((p) => p.id === "openrouter");
    expect(openrouter?.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("keeps providers with unknown base URLs but exposes null", () => {
    const providers = parseModelCatalog(SAMPLE);
    const nostalgic = providers.find((p) => p.id === "nostalgiacorp");
    expect(nostalgic?.baseUrl).toBeNull();
    expect(nostalgic?.models).toHaveLength(1);
  });

  it("captures reasoning flag and context length", () => {
    const providers = parseModelCatalog(SAMPLE);
    const model = providers.find((p) => p.id === "openrouter")?.models.find((m) => m.id === "deepcogito/cogito-v2.1-671b");
    expect(model?.reasoning).toBe(true);
    expect(model?.context).toBe(128000);
    const retro = providers.find((p) => p.id === "nostalgiacorp")?.models[0];
    expect(retro?.context).toBeNull();
  });

  it("degrades to an empty list on corrupt input", () => {
    expect(parseModelCatalog("not json")).toEqual([]);
    expect(parseModelCatalog("[]")).toEqual([]);
    expect(parseModelCatalog('{"x": 1}')).toEqual([]);
  });

  it("sorts providers and models by name", () => {
    const providers = parseModelCatalog(SAMPLE);
    expect(providers.map((p) => p.id)).toEqual(["nostalgiacorp", "openai", "openrouter"]);
    expect(providers.find((p) => p.id === "openai")?.models.map((m) => m.id)).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });
});

describe("getModelCatalog / listCatalogProviders / getCatalogProviderModels", () => {
  it("serves a seeded cache without network and applies the 6h TTL", async () => {
    const providers = parseModelCatalog(SAMPLE);
    _resetModelCatalogCache({ fetchedAt: Date.now(), providers });
    const now = Date.now();

    const catalog = await getModelCatalog(now);
    expect(catalog.providers).toHaveLength(3);

    const listed = await listCatalogProviders(now);
    expect(listed).toHaveLength(3);
    const openrouter = listed.find((p) => p.id === "openrouter");
    expect(openrouter?.modelCount).toBe(1); // image-only filtered out

    const openai = await getCatalogProviderModels("openai", now);
    expect(openai?.models.map((m) => m.id)).toEqual(["gpt-4o", "gpt-4o-mini"]);

    const unknown = await getCatalogProviderModels("nope", now);
    expect(unknown).toBeUndefined();
  });

  it("treats a cache past the TTL as stale (falls through to fetch)", async () => {
    const providers = parseModelCatalog(SAMPLE);
    _resetModelCatalogCache({ fetchedAt: Date.now() - MODEL_CATALOG_TTL_MS - 1, providers });
    // With a stale in-memory cache and no on-disk cache, the lib tries the
    // network; in the test env fetch fails fast (no network) and we degrade
    // to the stale in-memory copy rather than throwing.
    const catalog = await getModelCatalog(Date.now());
    expect(catalog.providers.length).toBeGreaterThan(0);
    _resetModelCatalogCache();
  });
});
