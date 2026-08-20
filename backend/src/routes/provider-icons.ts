import { Elysia } from "elysia";
import { authPlugin } from "../auth";
import { batchResolveProviderIconUrls, normalizeProvider } from "../lib/provider-icons";

type Ctx = Readonly<{
  query?: Readonly<Record<string, string>>;
  request: Readonly<{ url: string }>;
  set: Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;
}>;

export const providerIconRoutes = new Elysia()
  .use(authPlugin)
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
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "provider-name is required" }] };
    }

    const invalid = names.filter((name): boolean => normalizeProvider(name) === null);
    if (invalid.length > 0) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `Invalid provider name: ${invalid[0]}` }] };
    }

    const mapping = await batchResolveProviderIconUrls(names);
    const data = names.map((name): Record<string, unknown> => {
      const key = normalizeProvider(name)!;
      return {
        id: key,
        type: "provider-icons",
        attributes: {
          "provider-name": key,
          "icon-url": (mapping as Record<string, string | null>)[key] ?? null,
        },
      };
    });

    return { data };
  });
