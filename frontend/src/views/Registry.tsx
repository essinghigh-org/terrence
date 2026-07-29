import { createElement, useEffect, useState, type JSX } from "react";
import { Globe2, Package, SearchX, ServerCrash } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { fetchAllApiPages } from "../lib/api";
import { cn } from "../lib/utils";

type RegistryModule = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    namespace: string;
    provider: string;
    "created-at"?: string;
  }>;
}>;

type RegistryProvider = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    namespace: string;
    "registry-name"?: string;
    "created-at"?: string;
  }>;
}>;

type RegistryCard = Readonly<{
  id: string;
  name: string;
  source: string;
  detail: string;
  createdAt: string | undefined;
}>;

function createdLabel(createdAt: string | undefined): string {
  if (createdAt === undefined) return "Created date unavailable";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "Created date unavailable";
  return `Added ${date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The registry could not be loaded.";
}

export function Registry(): JSX.Element {
  const { orgName = "" } = useParams<{ orgName: string }>();
  const [searchParams] = useSearchParams();
  const [modules, setModules] = useState<readonly RegistryModule[]>([]);
  const [providers, setProviders] = useState<readonly RegistryProvider[]>([]);
  const [modulesError, setModulesError] = useState<string | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [reload, setReload] = useState(0);

  const activeTab = searchParams.get("tab") === "providers" ? "providers" : "modules";
  const registryPath = `/app/${encodeURIComponent(orgName)}/registry`;

  useEffect((): (() => void) => {
    const controller = new AbortController();
    setModules([]);
    setProviders([]);
    setModulesError(null);
    setProvidersError(null);
    setLoading(true);

    void Promise.allSettled([
      fetchAllApiPages<RegistryModule>(
        `/organizations/${encodeURIComponent(orgName)}/registry-modules`,
        controller.signal,
      ),
      fetchAllApiPages<RegistryProvider>(
        `/organizations/${encodeURIComponent(orgName)}/registry-providers`,
        controller.signal,
      ),
    ]).then(([modulesResult, providersResult]): void => {
      if (controller.signal.aborted) return;

      if (modulesResult.status === "fulfilled") {
        setModules(modulesResult.value);
      } else {
        setModulesError(errorMessage(modulesResult.reason));
      }

      if (providersResult.status === "fulfilled") {
        setProviders(providersResult.value);
      } else {
        setProvidersError(errorMessage(providersResult.reason));
      }
    }).finally((): void => {
      if (!controller.signal.aborted) setLoading(false);
    });

    return (): void => {
      controller.abort();
    };
  }, [orgName, reload]);

  const cards: readonly RegistryCard[] = (
    activeTab === "modules"
      ? modules.map(({ id, attributes }): RegistryCard => ({
          id,
          name: attributes.name,
          source: `${attributes.namespace}/${attributes.name}/${attributes.provider}`,
          detail: attributes.provider,
          createdAt: attributes["created-at"],
        }))
      : providers.map(({ id, attributes }): RegistryCard => ({
          id,
          name: attributes.name,
          source: `${attributes["registry-name"] ?? "private"}/${attributes.namespace}/${attributes.name}`,
          detail: attributes["registry-name"] ?? "private",
          createdAt: attributes["created-at"],
        }))
  ).filter((card): boolean => {
    const query = search.trim().toLocaleLowerCase();
    return query === "" || `${card.name} ${card.source} ${card.detail}`.toLocaleLowerCase().includes(query);
  }).sort((left, right): number => left.name.localeCompare(right.name));

  const tabLabel = activeTab === "modules" ? "Modules" : "Providers";
  const itemLabel = activeTab === "modules" ? "modules" : "providers";
  const currentError = activeTab === "modules" ? modulesError : providersError;

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">
          {orgName} / Registry / {tabLabel}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Registry</h1>
        <p className="text-muted-foreground">
          Browse private modules and providers available to this organization.
        </p>
      </header>

      <div className="max-w-4xl space-y-5">
        <Input
          aria-label="Search registry"
          onInput={(event): void => {
            setSearch(event.currentTarget.value);
          }}
          placeholder="Filter providers and modules"
          type="search"
          value={search}
        />

        <nav aria-label="Registry sections" className="flex gap-6 border-b">
          {([
            { label: "Modules", to: registryPath, icon: Package, value: "modules" },
            { label: "Providers", to: `${registryPath}?tab=providers`, icon: Globe2, value: "providers" },
          ] as const).map((tab): JSX.Element => {
            const active = activeTab === tab.value;
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px flex items-center gap-2 border-b-2 px-1 pb-3 text-sm font-medium",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
                key={tab.value}
                to={tab.to}
              >
                {createElement(tab.icon, { "aria-hidden": true, className: "size-4" })}
                {tab.label}
              </Link>
            );
          })}
        </nav>

        {loading ? (
          <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner />
            Loading registry…
          </div>
        ) : currentError !== null ? (
          <Empty className="min-h-64 border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ServerCrash /></EmptyMedia>
              <EmptyTitle>{tabLabel} unavailable</EmptyTitle>
              <EmptyDescription>{currentError}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                onClick={(): void => {
                  setReload((value): number => value + 1);
                }}
                type="button"
              >
                Try again
              </Button>
            </EmptyContent>
          </Empty>
        ) : cards.length === 0 ? (
          <Empty className="min-h-64 border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><SearchX /></EmptyMedia>
              <EmptyTitle>
                {search.trim() === ""
                  ? `No private ${itemLabel}`
                  : `No ${itemLabel} match your search`}
              </EmptyTitle>
              <EmptyDescription>
                {search.trim() === ""
                  ? `This organization has no published private ${itemLabel}.`
                  : "Try a different search."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-4">
            {cards.map((card): JSX.Element => (
              <Card key={card.id} size="sm">
                <CardHeader>
                  <CardTitle>{card.name}</CardTitle>
                  <CardDescription>
                    <code className="break-all">{card.source}</code>
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  <Badge variant="outline">Private</Badge>
                  <Badge variant="secondary">{card.detail}</Badge>
                </CardContent>
                <CardFooter>
                  <span className="text-xs text-muted-foreground">{createdLabel(card.createdAt)}</span>
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
