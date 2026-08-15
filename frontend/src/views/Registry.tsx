import { AlertTriangle, Globe2, Package, SearchX, ServerCrash } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { PageHeader, PageShell } from "../components/PageHeader";
import { PublishModuleDialog } from "../components/PublishModuleDialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Select, SelectItem } from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { useOrganizationPermissions } from "../hooks/useOrganizationPermissions";
import { fetchApi } from "../lib/api";
import { registryModuleFromResource, registryModulePath, type RegistryModule } from "../lib/registry";
import { cn } from "../lib/utils";
import { isRecord, isString } from "../lib/type-guards";

type RegistryProvider = Readonly<{
  id: string;
  name: string;
  namespace: string;
  registryName: string;
  createdAt: string;
}>;

function providerFromResource(resource: unknown): RegistryProvider {
// SAFETY: the fixture object is read as a record; each field is typed below.
  const raw = isRecord(resource) ? resource as Record<string, unknown> : {};
// SAFETY: the fixture object is read as a record; each field is typed below.
  const attributes = isRecord(raw["attributes"]) ? raw["attributes"] as Record<string, unknown> : {};
  return {
    id: isString(raw["id"]) ? raw["id"] : "",
    name: isString(attributes["name"]) ? attributes["name"] : "",
    namespace: isString(attributes["namespace"]) ? attributes["namespace"] : "",
    registryName: isString(attributes["registry-name"]) ? attributes["registry-name"] : "private",
    createdAt: isString(attributes["created-at"]) ? attributes["created-at"] : "",
  };
}

function dateLabel(value: string): string {
  if (value === "") return "Not published";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown date" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function publishingLabel(module: RegistryModule): string {
  if (module.publishingMechanism === "manual") return "Manual / API";
  return module.publishingWorkflow === "branch" ? "Branch-based" : "Tag-based";
}

export function Registry(): React.JSX.Element {
  const { orgName = "" } = useParams<{ orgName?: string }>();
  const [searchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") === "providers" ? "providers" : "modules";
  const [search, setSearch] = useState("");
  const [moduleSearch, setModuleSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [publishingFilter, setPublishingFilter] = useState("");
  const [page, setPage] = useState(1);
  const [modules, setModules] = useState<RegistryModule[]>([]);
  const [providers, setProviders] = useState<RegistryProvider[]>([]);
  const [providerOptions, setProviderOptions] = useState<string[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [publishOpen, setPublishOpen] = useState(false);
  const permissions = useOrganizationPermissions(orgName);
  const registryPath = `/app/${encodeURIComponent(orgName)}/registry`;

  useEffect((): (() => void) => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const load = async (): Promise<void> => {
      if (activeTab === "modules") {
        const query = new URLSearchParams({ "page[number]": String(page), "page[size]": "20" });
        if (moduleSearch.trim() !== "") query.set("q", moduleSearch.trim());
        if (providerFilter !== "") query.set("filter[provider]", providerFilter);
        if (publishingFilter !== "") query.set("filter[publishing_mechanism]", publishingFilter);
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
        const response = await fetchApi(`/organizations/${encodeURIComponent(orgName)}/registry-modules?${query.toString()}`, { signal: controller.signal }) as {
          data?: unknown[];
          meta?: { pagination?: { "total-pages"?: number }; providers?: unknown[] };
        };
        if (!controller.signal.aborted) {
          setModules(Array.isArray(response.data) ? response.data.map(registryModuleFromResource) : []);
          setProviderOptions(Array.isArray(response.meta?.providers) ? response.meta.providers.filter((value): value is string => isString(value)) : []);
          setTotalPages(response.meta?.pagination?.["total-pages"] ?? 1);
        }
      } else {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const response = await fetchApi(`/organizations/${encodeURIComponent(orgName)}/registry-providers`, { signal: controller.signal }) as { data?: unknown[] };
        if (!controller.signal.aborted) setProviders(Array.isArray(response.data) ? response.data.map(providerFromResource) : []);
      }
    };
    void load()
      .catch((caught: unknown): void => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Registry could not be loaded."); })
      .finally((): void => { if (!controller.signal.aborted) setLoading(false); });
    return (): void => { controller.abort(); };
  }, [activeTab, moduleSearch, orgName, page, providerFilter, publishingFilter, reload]);

  useEffect((): void => { setPage(1); }, [activeTab, orgName]);
  useEffect((): (() => void) | undefined => {
    if (activeTab !== "modules") return undefined;
    const timeout = setTimeout((): void => { setPage(1); setModuleSearch(search); }, 250);
    return (): void => { clearTimeout(timeout); };
  }, [activeTab, search]);

  const visibleProviders = providers.filter((provider): boolean => {
    const query = search.trim().toLocaleLowerCase();
    return query === "" || `${provider.namespace} ${provider.name}`.toLocaleLowerCase().includes(query);
  });
  const items = activeTab === "modules" ? modules : visibleProviders;
  const filtered = search.trim() !== "" || (activeTab === "modules" && (providerFilter !== "" || publishingFilter !== ""));
  const canPublish = permissions.loaded && permissions.has("can-manage-modules");

  return (
    <PageShell>
      <PageHeader
        title="Private registry"
        description="Discover and publish trusted Terraform modules and providers."
        action={activeTab === "modules" && canPublish ? <Button type="button" onClick={(): void => { setPublishOpen(true); }}>Publish module</Button> : undefined}
      />
      {canPublish && <PublishModuleDialog open={publishOpen} orgName={orgName} onOpenChange={setPublishOpen} />}

      <div className="max-w-5xl space-y-5">
        <nav aria-label="Registry sections" className="flex gap-6 border-b">
          <Link aria-current={activeTab === "modules" ? "page" : undefined} className={cn("-mb-px flex items-center gap-2 border-b-2 px-1 pb-3 text-sm font-medium", activeTab === "modules" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")} to={registryPath}><Package aria-hidden="true" className="size-4" />Modules</Link>
          <Link aria-current={activeTab === "providers" ? "page" : undefined} className={cn("-mb-px flex items-center gap-2 border-b-2 px-1 pb-3 text-sm font-medium", activeTab === "providers" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")} to={`${registryPath}?tab=providers`}><Globe2 aria-hidden="true" className="size-4" />Providers</Link>
        </nav>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_12rem]">
          <Input aria-label="Search registry" type="search" value={search} onInput={(event): void => { setSearch(event.currentTarget.value); }} placeholder={`Search ${activeTab}…`} />
          {activeTab === "modules" && (
            <>
              <Select aria-label="Filter by provider" value={providerFilter} onValueChange={(value): void => { setPage(1); setProviderFilter(value); }}>
                <SelectItem value="">All providers</SelectItem>
                {providerOptions.map((provider) => <SelectItem value={provider} key={provider}>{provider}</SelectItem>)}
              </Select>
              <Select aria-label="Filter by publishing type" value={publishingFilter} onValueChange={(value): void => { setPage(1); setPublishingFilter(value); }}>
                <SelectItem value="">All publishing types</SelectItem>
                <SelectItem value="vcs">VCS</SelectItem>
                <SelectItem value="manual">Manual / API</SelectItem>
              </Select>
            </>
          )}
        </div>

        {loading ? (
          <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><Spinner />Loading registry…</div>
        ) : error !== null ? (
          <Empty className="min-h-64 border"><EmptyHeader><EmptyMedia variant="icon"><ServerCrash /></EmptyMedia><EmptyTitle>{activeTab === "modules" ? "Modules" : "Providers"} unavailable</EmptyTitle><EmptyDescription>{error}</EmptyDescription></EmptyHeader><EmptyContent><Button type="button" onClick={(): void => { setReload((value): number => value + 1); }}>Try again</Button></EmptyContent></Empty>
        ) : items.length === 0 ? (
          <Empty className="min-h-64 border"><EmptyHeader><EmptyMedia variant="icon"><SearchX /></EmptyMedia><EmptyTitle>{filtered ? `No ${activeTab} match your filters` : `No private ${activeTab}`}</EmptyTitle><EmptyDescription>{filtered ? "Try a different search or filter." : `This organization has no published private ${activeTab}.`}</EmptyDescription></EmptyHeader></Empty>
        ) : activeTab === "modules" ? (
          <div className="grid gap-3">
            {modules.map((module) => {
              const latest = module.versions.find((version): boolean => version.status === "ok" && !version.revoked);
              return (
                <Link key={module.id} to={registryModulePath(orgName, module)} className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Card size="sm" className="transition-colors hover:border-primary/50 hover:bg-muted/30">
                    <CardHeader><CardTitle className="flex items-center gap-2">{module.name}{module.lastSyncError !== null && <AlertTriangle aria-label="Latest sync failed" className="size-4 text-destructive" />}</CardTitle><CardDescription><code className="break-all">{module.namespace}/{module.name}/{module.provider}</code></CardDescription></CardHeader>
                    <CardContent className="space-y-3"><p className="line-clamp-2 text-sm text-muted-foreground">{module.description ?? "No description provided."}</p><div className="flex flex-wrap gap-2"><Badge variant="outline">Private</Badge><Badge variant="secondary">{module.provider}</Badge><Badge variant="secondary">{publishingLabel(module)}</Badge>{latest !== undefined && <Badge variant="outline">v{latest.version}</Badge>}</div></CardContent>
                    <CardFooter><span className="text-xs text-muted-foreground">Updated {dateLabel(module.updatedAt)}</span></CardFooter>
                  </Card>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="grid gap-3">
            {visibleProviders.map((provider) => (
              <Link key={provider.id} to={`${registryPath}/providers/${encodeURIComponent(provider.namespace)}/${encodeURIComponent(provider.name)}`} className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Card size="sm" className="transition-colors hover:border-primary/50 hover:bg-muted/30"><CardHeader><CardTitle>{provider.name}</CardTitle><CardDescription><code>{provider.registryName}/{provider.namespace}/{provider.name}</code></CardDescription></CardHeader><CardContent><Badge variant="outline">{provider.registryName}</Badge></CardContent><CardFooter><span className="text-xs text-muted-foreground">Created {dateLabel(provider.createdAt)}</span></CardFooter></Card>
              </Link>
            ))}
          </div>
        )}

        {activeTab === "modules" && !loading && error === null && totalPages > 1 && (
          <nav aria-label="Registry pagination" className="flex items-center justify-between"><Button type="button" variant="outline" disabled={page <= 1} onClick={(): void => { setPage((value): number => Math.max(1, value - 1)); }}>Previous</Button><span className="text-sm text-muted-foreground">Page {page} of {totalPages}</span><Button type="button" variant="outline" disabled={page >= totalPages} onClick={(): void => { setPage((value): number => value + 1); }}>Next</Button></nav>
        )}
      </div>
    </PageShell>
  );
}