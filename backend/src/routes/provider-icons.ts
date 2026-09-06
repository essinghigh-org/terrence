import { Elysia } from "elysia";
import { authPlugin } from "../auth";
import { avatarHandler } from "./avatars";
import {
  batchResolveProviderIconPaths,
  cachedProviderIconUrl,
  providerIconFallbackSvg,
  normalizeProvider,
  scheduleProviderIconDiscovery,
} from "../lib/provider-icons";
import { DEFAULT_PROVIDER_REGISTRY_HOST, parseProviderSource } from "../lib/provider-source";

type SetContext = { status?: number | string; headers: Record<string, string | number> };
type Ctx = Readonly<{
  query?: Readonly<Record<string, string>>;
  request: Readonly<{ url: string }>;
  set: SetContext;
}>;
type ImageCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  request: Request;
  set: SetContext;
}>;

function providerIconNotFound(set: SetContext): Record<string, unknown> {
  set.status = 404;
  return { errors: [{ status: "404", title: "Not Found" }] };
}

function providerIconFallback(providerName: string, set: SetContext): Response | Record<string, unknown> {
  const fallback = providerIconFallbackSvg(providerName);
  if (fallback === null) return providerIconNotFound(set);
  const headers = new Headers({
    "Cache-Control": "private, no-cache",
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'none'; style-src 'none'; sandbox",
    "Content-Type": "image/svg+xml; charset=utf-8",
    "ETag": fallback.etag,
  });
  set.status = 200;
  set.headers["Cache-Control"] = "private, no-cache";
  set.headers["Content-Security-Policy"] = headers.get("Content-Security-Policy") ?? "";
  set.headers["Content-Type"] = "image/svg+xml; charset=utf-8";
  set.headers["ETag"] = fallback.etag;
  return new Response(fallback.body, { headers });
}

async function serveProviderIconImage(
  providerName: string,
  request: Request,
  set: SetContext,
): Promise<unknown> {
  const source = parseProviderSource(providerName);
  if (source === null || source.hostname !== DEFAULT_PROVIDER_REGISTRY_HOST) return providerIconNotFound(set);

  // Serve a known avatar without waiting for a registry lookup. A cache miss
  // gets a deterministic same-origin SVG while metadata discovery proceeds in
  // the background, so a slow registry cannot block the image response.
  const avatarUrl = cachedProviderIconUrl(source.source);
  const avatarMatch = avatarUrl === null ? null : /^\/api\/v2\/avatars\/([0-9a-f]{64})$/.exec(avatarUrl);
  const avatarKey = avatarMatch?.[1];
  if (avatarKey === undefined) {
    scheduleProviderIconDiscovery(source.source);
    return providerIconFallback(source.source, set);
  }
  return avatarHandler({
    params: { key: avatarKey },
    request,
    set: set as { status: number | string; headers: Record<string, string | number> },
  });
}

export const providerIconRoutes = new Elysia()
  .use(authPlugin)
  .get("/api/v2/provider-icons/:hostname/:namespace/:name", async ({ params, request, set }: ImageCtx): Promise<unknown> => {
    const providerName = `${params["hostname"] ?? ""}/${params["namespace"] ?? ""}/${params["name"] ?? ""}`;
    return serveProviderIconImage(providerName, request, set);
  })
  .get("/api/v2/provider-icons", async ({ query, request, set }: Ctx): Promise<unknown> => {
    const url = new URL(request.url);
    // Support both ?provider-name= and ?provider_name=, repeated or comma-separated.
    const raw = [
      ...url.searchParams.getAll("provider-name"),
      ...url.searchParams.getAll("provider_name"),
      ...url.searchParams.getAll("provider-name[]"),
      ...url.searchParams.getAll("provider_name[]"),
    ];
    // Fallback when the runtime collapsed the query into `query` only (single value).
    if (raw.length === 0 && query !== undefined) {
      const single = (query as Record<string, string>)["provider-name"]
        ?? (query as Record<string, string>)["provider_name"];
      if (typeof single === "string" && single !== "") raw.push(single);
    }
    const names = raw
      .flatMap((value): string[] => value.split(","))
      .map((value): string => value.trim())
      .filter((value): boolean => value !== "")
      .slice(0, 32); // cap fan-out per request

    if (names.length === 0) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "provider-name is required" }] };
    }

    const canonicalNames: string[] = [];
    for (const name of names) {
      const canonical = normalizeProvider(name);
      if (canonical === null) {
        set.status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `Invalid provider name: ${name}` }] };
      }
      canonicalNames.push(canonical);
    }

    const mapping = batchResolveProviderIconPaths(canonicalNames);
    const data = canonicalNames.map((key): Record<string, unknown> => {
      const resolved = (mapping as Record<string, string | null>)[key] ?? null;
      return {
        id: key,
        type: "provider-icons",
        attributes: {
          "provider-name": key,
          "icon-url": resolved,
        },
      };
    });

    return { data };
  });
