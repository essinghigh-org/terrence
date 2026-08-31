import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageShell } from "../components/PageHeader";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Spinner } from "../components/ui/spinner";
import { fetchApi } from "../lib/api";
import { isRecord, isString } from "../lib/type-guards";
import type { JsonObject } from "@/lib/json";

type Platform = Readonly<{ id: string; os: string; arch: string; filename: string; shasum: string }>;
type Version = Readonly<{ id: string; version: string; protocols: readonly string[]; keyId: string | null; createdAt: string; platforms: readonly Platform[] }>;

function stringValue(value: unknown): string {
  return isString(value) ? value : "";
}

function platformFromResource(raw: unknown): Platform {
// SAFETY: the fixture object is read as a record; each field is typed below.
  const item = isRecord(raw) ? raw as JsonObject : {};
  const rawAttributes = item["attributes"];
// SAFETY: the fixture object is read as a record; each field is typed below.
  const attributes = isRecord(rawAttributes) ? rawAttributes as JsonObject : {};
  return {
    id: stringValue(item["id"]),
    os: stringValue(attributes["os"]),
    arch: stringValue(attributes["arch"]),
    filename: stringValue(attributes["filename"]),
    shasum: stringValue(attributes["shasum"]),
  };
}

export function RegistryProviderDetail(): React.JSX.Element {
  const { orgName = "", namespace = "", name = "" } = useParams<{ orgName?: string; namespace?: string; name?: string }>();
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect((): (() => void) => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const providerResponse = await fetchApi(`/organizations/${encodeURIComponent(orgName)}/registry-providers/private/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`, { signal: controller.signal }) as { data: { id: string } };
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const versionResponse = await fetchApi(`/registry-providers/${encodeURIComponent(providerResponse.data.id)}/versions`, { signal: controller.signal }) as { data?: unknown[] };
      const loaded = await Promise.all((versionResponse.data ?? []).map(async (raw): Promise<Version> => {
// SAFETY: the fixture object is read as a record; each field is typed below.
        const item = isRecord(raw) ? raw as JsonObject : {};
        const rawAttributes = item["attributes"];
// SAFETY: the fixture object is read as a record; each field is typed below.
        const attributes = isRecord(rawAttributes) ? rawAttributes as JsonObject : {};
        const id = stringValue(item["id"]);
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const platformResponse = await fetchApi(`/registry-provider-versions/${encodeURIComponent(id)}/platforms`, { signal: controller.signal }) as { data?: unknown[] };
        return {
          id,
          version: stringValue(attributes["version"]),
          protocols: Array.isArray(attributes["protocols"]) ? attributes["protocols"].filter((value): value is string => isString(value)) : [],
          keyId: isString(attributes["key-id"]) ? attributes["key-id"] : null,
          createdAt: stringValue(attributes["created-at"]),
          platforms: (platformResponse.data ?? []).map(platformFromResource),
        };
      }));
      if (!controller.signal.aborted) setVersions(loaded);
    };
    void load()
      .catch((caught: unknown): void => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Provider could not be loaded."); })
      .finally((): void => { if (!controller.signal.aborted) setLoading(false); });
    return (): void => { controller.abort(); };
  }, [name, namespace, orgName]);

  if (loading) return <PageShell><div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><Spinner />Loading provider…</div></PageShell>;
  if (error !== null) return <PageShell><Empty><EmptyHeader><EmptyTitle>Provider unavailable</EmptyTitle><EmptyDescription>{error}</EmptyDescription></EmptyHeader></Empty></PageShell>;
  return (
    <PageShell>
      <div className="max-w-4xl space-y-6">
        <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground"><Link className="hover:text-foreground" to={`/app/${encodeURIComponent(orgName)}/registry?tab=providers`}>Registry providers</Link><span aria-hidden="true"> / </span><span>{namespace}</span><span aria-hidden="true"> / </span><span aria-current="page">{name}</span></nav>
        <div><h1 className="text-2xl font-semibold tracking-tight">{name}</h1><code className="text-sm text-muted-foreground">private/{namespace}/{name}</code></div>
        {versions.length === 0 ? (
          <Empty className="border"><EmptyHeader><EmptyTitle>No provider versions</EmptyTitle><EmptyDescription>This provider has no published versions.</EmptyDescription></EmptyHeader></Empty>
        ) : versions.map((version): React.JSX.Element => (
          <Card key={version.id}>
            <CardHeader><CardTitle className="flex items-center gap-2">v{version.version}<Badge variant="outline">Protocols {version.protocols.length === 0 ? "unknown" : version.protocols.join(", ")}</Badge></CardTitle><CardDescription>{version.keyId === null ? "Unsigned" : `Signing key ${version.keyId}`} · {version.createdAt === "" ? "Unknown publication date" : new Date(version.createdAt).toLocaleDateString()}</CardDescription></CardHeader>
            <CardContent className="space-y-2">{version.platforms.map((platform): React.JSX.Element => <div key={platform.id} className="grid gap-1 rounded-md border p-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]"><span className="font-medium">{platform.os}/{platform.arch}</span><div className="min-w-0"><p className="truncate">{platform.filename}</p><code className="block truncate text-xs text-muted-foreground" title={platform.shasum}>{platform.shasum}</code></div></div>)}</CardContent>
          </Card>
        ))}
      </div>
    </PageShell>
  );
}