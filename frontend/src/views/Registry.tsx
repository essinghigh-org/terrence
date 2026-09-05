import { Terrence } from "../components/brand/Terrence";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Globe2,
  Package,
  Search,
  SearchX,
  Tag,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { PageHeader, PageShell } from "../components/PageHeader";
import { PublishModuleDialog } from "../components/PublishModuleDialog";
import { ProviderIcon } from "../components/ProviderIcon";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Select, SelectItem } from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { useOrganizationPermissions } from "../hooks/useOrganizationPermissions";
import { fetchApi } from "../lib/api";
import { registryModuleFromResource, highestUsableRegistryVersion, registryModulePath, type RegistryModule } from "../lib/registry";
import { cn } from "../lib/utils";
import { isRecord, isString } from "../lib/type-guards";
import type { JsonObject } from "@/lib/json";

type RegistryProvider = Readonly<{
  id: string;
  name: string;
  namespace: string;
  registryName: string;
  createdAt: string;
}>;

type RegistryTab = "modules" | "providers";
type RegistrySort = "updated" | "name" | "provider";

type ModuleListResponse = Readonly<{
  data?: unknown[];
  meta?: Readonly<{
    pagination?: Readonly<{
      "total-pages"?: number;
      "total-count"?: number;
    }>;
    providers?: unknown[];
  }>;
}>;

type ProviderListResponse = Readonly<{
  data?: unknown[];
  meta?: Readonly<{ "total-count"?: number }>;
}>;

function providerFromResource(resource: unknown): RegistryProvider {
  // SAFETY: the fixture object is read as a record; each field is typed below.
  const raw = isRecord(resource) ? resource as JsonObject : {};
  // SAFETY: the fixture object is read as a record; each field is typed below.
  const attributes = isRecord(raw["attributes"]) ? raw["attributes"] as JsonObject : {};
  return {
    id: isString(raw["id"]) ? raw["id"] : "",
    name: isString(attributes["name"]) ? attributes["name"] : "",
    namespace: isString(attributes["namespace"]) ? attributes["namespace"] : "",
    registryName: isString(attributes["registry-name"]) ? attributes["registry-name"] : "private",
    createdAt: isString(attributes["created-at"]) ? attributes["created-at"] : "",
  };
}

function parsePage(value: string | null): number {
  if (value === null) return 1;
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function parseSort(value: string | null): RegistrySort {
  return value === "name" || value === "provider" ? value : "updated";
}

function dateLabel(value: string): string {
  if (value === "") return "Not published";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Unknown date"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function relativeDateLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "unknown date";

  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(seconds);
  if (absoluteSeconds < 60) return "just now";

  const units: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const unit = units.find(([, size]): boolean => absoluteSeconds >= size) ?? ["minute", 60];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    Math.round(seconds / unit[1]),
    unit[0],
  );
}

function sourceLabel(module: RegistryModule): string {
  if (module.publishingMechanism === "manual") return "Manual / API";
  return module.publishingWorkflow === "branch" ? "Git branch" : "Git tag";
}

function syncLabel(module: RegistryModule): string {
  if (module.lastSyncError !== null) return "Sync failed";
  if (module.lastSuccessfulSyncAt !== null) return `Synced ${relativeDateLabel(module.lastSuccessfulSyncAt)}`;
  if (module.publishingMechanism === "manual") return "Uploaded directly";
  return "Awaiting first sync";
}

function moduleStatusLabel(module: RegistryModule): string {
  if (module.lastSyncError !== null) return "Needs attention";
  if (module.status === "setup_complete") return "Ready";
  if (module.status === "pending") return "Preparing";
  return module.status.replace(/_/g, " ");
}

function moduleRepositoryLabel(module: RegistryModule): string {
  return module.vcsRepo?.displayIdentifier
    ?? module.vcsRepo?.identifier
    ?? (module.publishingMechanism === "manual" ? "Terrence API" : "Repository pending");
}

function ModuleCard({ orgName, module }: Readonly<{ orgName: string; module: RegistryModule }>): React.JSX.Element {
  const latest = highestUsableRegistryVersion(module.versions);
  const repositoryLabel = moduleRepositoryLabel(module);
  const repositoryUrl = module.vcsRepo?.repositoryUrl ?? undefined;
  const syncIsHealthy = module.lastSyncError === null;

  return (
    <Link
      aria-label={`Open ${module.name} module details`}
      className="group block h-full cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      to={registryModulePath(orgName, module)}
    >
      <Card className="h-full border-transparent transition-[border-color,background-color,box-shadow] duration-200 hover:border-primary/30 hover:bg-muted/20 hover:shadow-sm">
        <CardContent className="flex h-full flex-col gap-6 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground ring-1 ring-primary/10">
                <ProviderIcon
                  alt={`${module.provider} provider logo`}
                  fallback={<Package aria-hidden="true" />}
                  providerName={module.providerSource}
                  size={24}
                />
              </div>
              <div className="min-w-0">
                <p className="truncate font-mono text-base font-semibold tracking-tight text-foreground">{module.name}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  <code>{module.namespace}/{module.name}</code>
                </p>
              </div>
            </div>
            <span className="shrink-0 font-mono text-sm font-semibold text-foreground">
              {latest === undefined ? "No release" : `v${latest.version}`}
            </span>
          </div>

          <p className="min-h-[4.5rem] line-clamp-3 text-sm leading-6 text-muted-foreground">
            {module.description ?? "No description provided."}
          </p>

          <div className="mt-auto flex flex-col gap-4">
            <div className="flex flex-wrap gap-x-4 gap-y-2 border-t pt-4 text-xs text-muted-foreground">
              <span className="inline-flex min-w-0 items-center gap-1.5 [&_svg]:size-3" title={repositoryUrl}>
                {module.publishingMechanism === "vcs" ? <GitBranch aria-hidden="true" /> : <Upload aria-hidden="true" />}
                <span className="truncate">{repositoryLabel}</span>
              </span>
              <span className="inline-flex items-center gap-1.5 [&_svg]:size-3">
                <Tag aria-hidden="true" />
                <span>{sourceLabel(module)}</span>
              </span>
              <span className="inline-flex items-center gap-1.5 [&_svg]:size-3">
                <Package aria-hidden="true" />
                <span>{module.provider}</span>
              </span>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className={cn(
                "flex min-w-0 items-center gap-1.5 text-xs [&_svg]:size-3.5",
                syncIsHealthy ? "text-success" : "text-destructive",
              )} title={module.lastSyncError ?? (module.lastSuccessfulSyncAt === null ? undefined : dateLabel(module.lastSuccessfulSyncAt))}>
                {syncIsHealthy ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
                <span className="truncate">{moduleStatusLabel(module)} · {syncLabel(module)}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                <span title={dateLabel(module.updatedAt)}>Updated {relativeDateLabel(module.updatedAt)}</span>
                <ArrowUpRight aria-hidden="true" className="size-4 shrink-0" />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function ProviderCard({ registryPath, provider }: Readonly<{ registryPath: string; provider: RegistryProvider }>): React.JSX.Element {
  return (
    <Link
      aria-label={`Open ${provider.name} provider details`}
      className="group block h-full cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      to={`${registryPath}/providers/${encodeURIComponent(provider.namespace)}/${encodeURIComponent(provider.name)}`}
    >
      <Card className="h-full border-transparent transition-[border-color,background-color,box-shadow] duration-200 hover:border-primary/30 hover:bg-muted/20 hover:shadow-sm">
        <CardContent className="flex h-full flex-col gap-6 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground ring-1 ring-foreground/10">
                <ProviderIcon
                  alt={`${provider.name} provider logo`}
                  fallback={<Globe2 aria-hidden="true" />}
                  providerName={null}
                  size={24}
                />
              </div>
              <div className="min-w-0">
                <p className="truncate font-mono text-base font-semibold tracking-tight text-foreground">{provider.name}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  <code>{provider.registryName}/{provider.namespace}/{provider.name}</code>
                </p>
              </div>
            </div>
            <ArrowUpRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
          </div>

          <div className="mt-auto flex items-center justify-between gap-4 border-t pt-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Globe2 aria-hidden="true" className="size-3" />
              Private provider
            </span>
            <span title={dateLabel(provider.createdAt)}>Added {relativeDateLabel(provider.createdAt)}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function SearchControl({
  activeTab,
  value,
  onChange,
  onClear,
}: Readonly<{
  activeTab: RegistryTab;
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
}>): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  const onChangeRef = useRef(onChange);

  useEffect((): void => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect((): void => {
    setDraft(value);
  }, [value]);

  useEffect((): (() => void) => {
    const timeout = window.setTimeout((): void => {
      if (draft !== value) onChangeRef.current(draft);
    }, 250);
    return (): void => { window.clearTimeout(timeout); };
  }, [draft, value]);

  return (
    <div className="relative min-w-0 flex-1">
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label="Search registry"
        className="h-10 pl-10 pr-10"
        placeholder={activeTab === "modules" ? "Search modules, providers, or namespaces" : "Search providers"}
        type="search"
        value={draft}
        onInput={(event): void => { setDraft(event.currentTarget.value); }}
      />
      {draft !== "" && (
        <Button
          aria-label="Clear registry search"
          className="absolute right-2 top-1/2 -translate-y-1/2"
          size="icon-xs"
          type="button"
          variant="ghost"
          onClick={(): void => { setDraft(""); onClear(); }}
        >
          <X aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

export function Registry(): React.JSX.Element {
  const { orgName = "" } = useParams<{ orgName?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab: RegistryTab = searchParams.get("tab") === "providers" ? "providers" : "modules";
  const search = searchParams.get("q") ?? "";
  const providerFilter = searchParams.get("provider") ?? "";
  const publishingFilter = searchParams.get("publishing") ?? "";
  const sort = parseSort(searchParams.get("sort"));
  const page = parsePage(searchParams.get("page"));
  const [modules, setModules] = useState<RegistryModule[]>([]);
  const [providers, setProviders] = useState<RegistryProvider[]>([]);
  const [providerOptions, setProviderOptions] = useState<string[]>([]);
  const [moduleCount, setModuleCount] = useState<number | null>(null);
  const [providerCount, setProviderCount] = useState<number | null>(null);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [publishOpen, setPublishOpen] = useState(false);
  const permissions = useOrganizationPermissions(orgName);
  const registryPath = `/app/${encodeURIComponent(orgName)}/registry`;
  const normalizedSearch = search.trim();

  useEffect((): (() => void) => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    if (activeTab === "modules") {
      setModuleCount(null);
      const query = new URLSearchParams({
        "page[number]": String(page),
        "page[size]": "20",
        sort,
      });
      if (normalizedSearch !== "") query.set("q", normalizedSearch);
      if (providerFilter !== "") query.set("filter[provider]", providerFilter);
      if (publishingFilter !== "") query.set("filter[publishing_mechanism]", publishingFilter);

      void fetchApi(`/organizations/${encodeURIComponent(orgName)}/registry-modules?${query.toString()}`, { signal: controller.signal })
        .then((response): void => {
          if (controller.signal.aborted) return;
          const body = response as ModuleListResponse;
          const loadedModules = Array.isArray(body.data) ? body.data.map(registryModuleFromResource) : [];
          const pagination = body.meta?.pagination;
          setModules(loadedModules);
          setProviderOptions(Array.isArray(body.meta?.providers) ? body.meta.providers.filter((value): value is string => isString(value)) : []);
          setModuleCount(typeof pagination?.["total-count"] === "number" ? pagination["total-count"] : loadedModules.length);
          setTotalPages(Math.max(1, pagination?.["total-pages"] ?? 1));
        })
        .catch((caught: unknown): void => {
          if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Registry could not be loaded.");
        })
        .finally((): void => {
          if (!controller.signal.aborted) setLoading(false);
        });
    } else {
      setProviderCount(null);
      void fetchApi(`/organizations/${encodeURIComponent(orgName)}/registry-providers`, { signal: controller.signal })
        .then((response): void => {
          if (controller.signal.aborted) return;
          const body = response as ProviderListResponse;
          const loadedProviders = Array.isArray(body.data) ? body.data.map(providerFromResource) : [];
          setProviders(loadedProviders);
          setProviderCount(typeof body.meta?.["total-count"] === "number" ? body.meta["total-count"] : loadedProviders.length);
        })
        .catch((caught: unknown): void => {
          if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Registry could not be loaded.");
        })
        .finally((): void => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }
    return (): void => { controller.abort(); };
  }, [activeTab, normalizedSearch, orgName, page, providerFilter, publishingFilter, reload, sort]);

  const updateBrowseParam = useCallback((key: string, value: string, resetPage = true): void => {
    const next = new URLSearchParams(searchParams);
    if (value === "") next.delete(key);
    else next.set(key, value);
    if (resetPage) next.delete("page");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const clearFilters = (): void => {
    const next = new URLSearchParams(searchParams);
    next.delete("q");
    next.delete("provider");
    next.delete("publishing");
    next.delete("page");
    setSearchParams(next, { replace: true });
  };

  const visibleProviders = [...providers]
    .filter((provider): boolean => {
      const query = normalizedSearch.toLocaleLowerCase();
      return query === "" || `${provider.namespace} ${provider.name}`.toLocaleLowerCase().includes(query);
    })
    .sort((left, right): number => {
      if (sort === "updated") return Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return left.name.localeCompare(right.name) || left.namespace.localeCompare(right.namespace);
    });
  const activeFilters = normalizedSearch !== "" || providerFilter !== "" || publishingFilter !== "";
  const collectionCount = activeTab === "modules" ? moduleCount : providerCount;
  const collectionHasItems = (collectionCount ?? (activeTab === "modules" ? modules.length : providers.length)) > 0;
  const showToolbar = loading || collectionHasItems || activeFilters;
  const canPublish = permissions.loaded && permissions.has("can-manage-modules");
  const visibleItems = activeTab === "modules" ? modules : visibleProviders;
  const pageHasNoResults = activeTab === "modules" && modules.length === 0 && page > 1 && (moduleCount ?? 0) > 0;

  return (
    <PageShell>
      <PageHeader
        action={activeTab === "modules" && canPublish ? (
          <Button type="button" onClick={(): void => { setPublishOpen(true); }}>
            <Upload aria-hidden="true" data-icon="inline-start" />
            Publish module
          </Button>
        ) : undefined}
        description="Discover and publish trusted Terraform and OpenTofu building blocks."
        eyebrow="Private infrastructure / catalog"
        title="Private registry"
      />
      {canPublish && <PublishModuleDialog open={publishOpen} orgName={orgName} onOpenChange={setPublishOpen} />}

      <nav aria-label="Registry sections" className="flex gap-6 border-b">
        <Link
          aria-current={activeTab === "modules" ? "page" : undefined}
          aria-label="Modules"
          className={cn(
            "-mb-px flex cursor-pointer items-center gap-2 border-b-2 px-1 pb-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
            activeTab === "modules" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
          to={registryPath}
        >
          <Package aria-hidden="true" />
          <span>Modules</span>
          <span aria-hidden="true" className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[0.7rem] text-muted-foreground">
            {moduleCount ?? "…"}
          </span>
        </Link>
        <Link
          aria-current={activeTab === "providers" ? "page" : undefined}
          aria-label="Providers"
          className={cn(
            "-mb-px flex cursor-pointer items-center gap-2 border-b-2 px-1 pb-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
            activeTab === "providers" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
          to={`${registryPath}?tab=providers`}
        >
          <Globe2 aria-hidden="true" />
          <span>Providers</span>
          <span aria-hidden="true" className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[0.7rem] text-muted-foreground">
            {providerCount ?? "…"}
          </span>
        </Link>
      </nav>

      {showToolbar && (
        <section aria-label="Registry browse controls" className="flex flex-col gap-3 rounded-xl border bg-card p-3 shadow-sm xl:flex-row xl:items-center">
          <SearchControl
            activeTab={activeTab}
            value={search}
            onChange={(value): void => { updateBrowseParam("q", value); }}
            onClear={(): void => { updateBrowseParam("q", ""); }}
          />
          <div className="grid gap-2 sm:grid-cols-2 lg:flex lg:shrink-0">
            {activeTab === "modules" && (
              <>
                <Select
                  aria-label="Filter by provider"
                  className="h-10 lg:w-44"
                  value={providerFilter}
                  onValueChange={(value): void => { updateBrowseParam("provider", value); }}
                >
                  <SelectItem value="">All providers</SelectItem>
                  {providerOptions.map((provider): React.JSX.Element => <SelectItem key={provider} value={provider}>{provider}</SelectItem>)}
                </Select>
                <Select
                  aria-label="Filter by publishing type"
                  className="h-10 lg:w-44"
                  value={publishingFilter}
                  onValueChange={(value): void => { updateBrowseParam("publishing", value); }}
                >
                  <SelectItem value="">All sources</SelectItem>
                  <SelectItem value="vcs">VCS</SelectItem>
                  <SelectItem value="manual">Manual / API</SelectItem>
                </Select>
              </>
            )}
            <Select
              aria-label={activeTab === "modules" ? "Sort registry" : "Sort providers"}
              className="h-10 lg:w-44"
              value={activeTab === "providers" && sort === "provider" ? "name" : sort}
              onValueChange={(value): void => { updateBrowseParam("sort", value === "updated" ? "" : value); }}
            >
              <SelectItem value="updated">Recently updated</SelectItem>
              <SelectItem value="name">Name</SelectItem>
              {activeTab === "modules" && <SelectItem value="provider">Provider</SelectItem>}
            </Select>
          </div>
        </section>
      )}

      {showToolbar && activeTab === "modules" && !loading && error === null && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <p>Showing {modules.length} of {moduleCount ?? modules.length} modules</p>
          {activeFilters && (
            <Button size="sm" type="button" variant="ghost" onClick={clearFilters}>
              Clear filters
              <X aria-hidden="true" data-icon="inline-end" />
            </Button>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
          <Spinner />
          Loading registry…
        </div>
      ) : error !== null ? (
        <Empty role="alert" className="min-h-64 border">
          <EmptyHeader>
            <Terrence pose="failed" className="w-36" />
            <EmptyTitle>{activeTab === "modules" ? "Modules" : "Providers"} unavailable</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" onClick={(): void => { setReload((value): number => value + 1); }}>Try again</Button>
          </EmptyContent>
        </Empty>
      ) : visibleItems.length === 0 ? (
        <Empty className="min-h-64 border">
          <EmptyHeader>
            {!activeFilters && !pageHasNoResults ? <Terrence pose="empty" className="w-40" /> : <EmptyMedia variant="icon"><SearchX aria-hidden="true" /></EmptyMedia>}
            <EmptyTitle>
              {pageHasNoResults
                ? "No modules on this page"
                : activeFilters
                  ? `No ${activeTab} match your filters`
                  : `No private ${activeTab}`}
            </EmptyTitle>
            <EmptyDescription>
              {pageHasNoResults
                ? "Return to the previous page to continue browsing."
                : activeFilters
                  ? "Try a different search or filter."
                  : `This organization has no published private ${activeTab}.`}
            </EmptyDescription>
          </EmptyHeader>
          {pageHasNoResults && (
            <EmptyContent>
              <Button type="button" variant="outline" onClick={(): void => { updateBrowseParam("page", String(Math.max(1, page - 1)), false); }}>
                <ChevronLeft aria-hidden="true" data-icon="inline-start" />
                Previous page
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : activeTab === "modules" ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {modules.map((module): React.JSX.Element => <ModuleCard key={module.id} module={module} orgName={orgName} />)}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {visibleProviders.map((provider): React.JSX.Element => <ProviderCard key={provider.id} provider={provider} registryPath={registryPath} />)}
        </div>
      )}

      {activeTab === "modules" && !loading && error === null && totalPages > 1 && (
        <nav aria-label="Registry pagination" className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <Button
            disabled={page <= 1}
            type="button"
            variant="outline"
            onClick={(): void => { updateBrowseParam("page", String(Math.max(1, page - 1)), false); }}
          >
            <ChevronLeft aria-hidden="true" data-icon="inline-start" />
            Previous
          </Button>
          <span className="font-mono text-xs text-muted-foreground">Page {page} of {totalPages}</span>
          <Button
            disabled={page >= totalPages}
            type="button"
            variant="outline"
            onClick={(): void => { updateBrowseParam("page", String(page + 1), false); }}
          >
            Next
            <ChevronRight aria-hidden="true" data-icon="inline-end" />
          </Button>
        </nav>
      )}
    </PageShell>
  );
}
