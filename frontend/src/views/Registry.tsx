import { createElement, useCallback, useEffect, useRef, useState, type JSX } from "react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "../components/ui/field";
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

async function registryApi<T>(
  url: string,
  options: Readonly<{ method?: string; body?: string; signal?: AbortSignal }> = {},
): Promise<T> {
  const base = "/api/v2";
  const headers: Record<string, string> = { "Content-Type": "application/vnd.api+json" };
  const token = (() => {
    try {
      return localStorage.getItem("tfe_token");
    } catch {
      return null;
    }
  })();
  if (token !== null && token !== "") {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const fetchOptions: RequestInit & { headers: Record<string, string> } = {
    method: options.method ?? "GET",
    headers,
    body: options.body ?? null,
  };
  if (options.signal !== undefined) {
    fetchOptions.signal = options.signal;
  }
  const response = await fetch(`${base}${url}`, fetchOptions);
  if (!response.ok) {
    const errorBody: unknown = await response.json().catch((): null => null);
    const rawErrors = Array.isArray((errorBody as Record<string, unknown> | null)?.["errors"])
      ? (errorBody as Record<string, unknown>)["errors"] as readonly Record<string, unknown>[]
      : [];
    const detail = typeof rawErrors[0]?.["detail"] === "string" ? (rawErrors[0] as Record<string, string>)["detail"] : null;
    throw new Error(detail ?? `API request failed (${response.status})`);
  }
  if (response.status === 204) return null as T;
  return (await response.json()) as T;
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

  // Publish dialog state
  const [publishOpen, setPublishOpen] = useState(false);
  const [step, setStep] = useState<"create-module" | "add-version">("create-module");
  const [newName, setNewName] = useState("");
  const [newProvider, setNewProvider] = useState("");
  const [newNamespace, setNewNamespace] = useState("");
  const [newVersion, setNewVersion] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState("");
  const [createdModuleId, setCreatedModuleId] = useState<string | null>(null);

  const fetchCountRef = useRef(0);

  const activeTab = searchParams.get("tab") === "providers" ? "providers" : "modules";
  const registryPath = `/app/${encodeURIComponent(orgName)}/registry`;

  useEffect((): (() => void) => {
    const controller = new AbortController();
    const fetchId = ++fetchCountRef.current;
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
      if (controller.signal.aborted || fetchId !== fetchCountRef.current) return;

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
      if (!controller.signal.aborted && fetchId === fetchCountRef.current) setLoading(false);
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
  const showPublish = activeTab === "modules" && currentError === null && !loading;

  const createModule = useCallback(async (): Promise<void> => {
    const name = newName.trim();
    const provider = newProvider.trim();
    if (name === "") { setPublishError("Module name is required."); return; }
    if (provider === "") { setPublishError("Provider is required."); return; }
    setPublishing(true);
    setPublishError("");
    try {
      const body = JSON.stringify({
        data: {
          type: "registry-modules",
          attributes: {
            name,
            provider,
            namespace: newNamespace.trim() || orgName,
          },
        },
      });
      const response = await registryApi<{ data: { id: string } }>(
        `/organizations/${encodeURIComponent(orgName)}/registry-modules`,
        { method: "POST", body },
      );
      setCreatedModuleId(response.data.id);
      setStep("add-version");
    } catch (error: unknown) {
      setPublishError(error instanceof Error ? error.message : "Failed to create module.");
    } finally {
      setPublishing(false);
    }
  }, [newName, newProvider, newNamespace, orgName]);

  const publishVersion = useCallback(async (): Promise<void> => {
    const version = newVersion.trim();
    if (version === "") { setPublishError("Version is required."); return; }
    if (createdModuleId === null) { setPublishError("No module created yet."); return; }
    setPublishing(true);
    setPublishError("");
    try {
      const body = JSON.stringify({
        data: {
          type: "registry-module-versions",
          attributes: { version },
        },
      });
      const versionResponse = await registryApi<{ data: { id: string } }>(
        `/registry-modules/${encodeURIComponent(createdModuleId)}/versions`,
        { method: "POST", body },
      );

      // Upload a minimal placeholder archive so the version is usable
      const emptyTarGz = new Uint8Array([
        0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x03, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
      ]);
      const token = (() => {
        try {
          return localStorage.getItem("tfe_token");
        } catch {
          return null;
        }
      })();
      const uploadHeaders: Record<string, string> = { "Content-Type": "application/octet-stream" };
      if (token !== null && token !== "") {
        uploadHeaders["Authorization"] = `Bearer ${token}`;
      }
      await fetch(
        `/api/v2/registry-module-versions/${versionResponse.data.id}/upload`,
        {
          method: "PUT",
          headers: uploadHeaders,
          body: emptyTarGz,
        },
      );

      setPublishOpen(false);
      setReload((value): number => value + 1);
    } catch (error: unknown) {
      setPublishError(error instanceof Error ? error.message : "Failed to publish version.");
    } finally {
      setPublishing(false);
    }
  }, [newVersion, createdModuleId, orgName]);

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {orgName} / Registry / {tabLabel}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Registry</h1>
          <p className="text-muted-foreground">
            Browse private modules and providers available to this organization.
          </p>
        </div>
        {showPublish && (
          <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
            <DialogTrigger render={<Button type="button">Publish</Button>} />
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Publish {step === "create-module" ? "module" : "version"}</DialogTitle>
                <DialogDescription>
                  {step === "create-module"
                    ? "Create a new private module in this organization's registry."
                    : "Add a version to complete the module publication."}
                </DialogDescription>
              </DialogHeader>

              {step === "create-module" ? (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="publish-name">Name</FieldLabel>
                    <Input
                      id="publish-name"
                      value={newName}
                      onChange={(e): void => { setNewName(e.target.value); }}
                      onInput={(e): void => { setNewName(e.currentTarget.value); }}
                      placeholder="vpc"
                      required
                      disabled={publishing}
                    />
                    <FieldDescription>A short, descriptive name for the module.</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="publish-provider">Provider</FieldLabel>
                    <Input
                      id="publish-provider"
                      value={newProvider}
                      onChange={(e): void => { setNewProvider(e.target.value); }}
                      onInput={(e): void => { setNewProvider(e.currentTarget.value); }}
                      placeholder="aws"
                      required
                      disabled={publishing}
                    />
                    <FieldDescription>The Terraform provider this module targets (e.g., aws, azurerm).</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="publish-namespace">Namespace</FieldLabel>
                    <Input
                      id="publish-namespace"
                      value={newNamespace}
                      onChange={(e): void => { setNewNamespace(e.target.value); }}
                      onInput={(e): void => { setNewNamespace(e.currentTarget.value); }}
                      placeholder={orgName}
                      disabled={publishing}
                    />
                    <FieldDescription>Defaults to the organization name.</FieldDescription>
                  </Field>
                </FieldGroup>
              ) : (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="publish-version">Version</FieldLabel>
                    <Input
                      id="publish-version"
                      value={newVersion}
                      onChange={(e): void => { setNewVersion(e.target.value); }}
                      onInput={(e): void => { setNewVersion(e.currentTarget.value); }}
                      placeholder="1.0.0"
                      required
                      disabled={publishing}
                    />
                    <FieldDescription>Semantic version for this module release.</FieldDescription>
                  </Field>
                </FieldGroup>
              )}

              {publishError !== "" && <FieldError>{publishError}</FieldError>}

              <DialogFooter>
                <Button type="button" variant="outline" disabled={publishing} onClick={(): void => { setPublishOpen(false); }}>
                  Cancel
                </Button>
                {step === "create-module" ? (
                  <Button type="button" disabled={publishing} onClick={createModule}>
                    {publishing ? "Creating…" : "Create module"}
                  </Button>
                ) : (
                  <Button type="button" disabled={publishing} onClick={publishVersion}>
                    {publishing ? "Publishing…" : "Publish version"}
                  </Button>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
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
