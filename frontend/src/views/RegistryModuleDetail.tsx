import { AlertTriangle, Check, Copy, ExternalLink, RefreshCw, Settings2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { MarkdownContent } from "../components/MarkdownContent";
import { PageShell } from "../components/PageHeader";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Select, SelectItem } from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { toast } from "../components/ui/toast";
import { fetchApi } from "../lib/api";
import {
  registryModuleFromResource,
  registryModuleVersionFromResource,
  type RegistryModule,
  type RegistryModuleSection,
  type RegistryModuleVersion,
} from "../lib/registry";
import { cn, copyTextToClipboard } from "../lib/utils";
import { isString } from "../lib/type-guards";
import type { JsonValue } from "@/lib/json";

type DetailTab = "readme" | "inputs" | "outputs" | "dependencies" | "resources";
type Confirmation = "revoke" | "delete-version" | "delete-module" | null;

function dateLabel(value: string | null): string {
  if (value === null || value === "") return "Not published";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown date" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function publishingLabel(module: RegistryModule): string {
  if (module.publishingMechanism === "manual") return "Manual / API";
  return module.publishingWorkflow === "branch" ? "Branch-based" : "Tag-based";
}

function displayDefault(value: unknown): string {
  if (isString(value)) return JSON.stringify(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function RegistryModuleDetail(): React.JSX.Element {
  const { orgName = "", namespace = "", name = "", provider = "" } = useParams<{
    orgName?: string;
    namespace?: string;
    name?: string;
    provider?: string;
  }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [module, setModule] = useState<RegistryModule | null>(null);
  const [versions, setVersions] = useState<RegistryModuleVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [tab, setTab] = useState<DetailTab>("readme");
  const [sectionPath, setSectionPath] = useState(".");
  const [copied, setCopied] = useState<"config" | "credentials" | null>(null);
  const copiedResetTimerRef = useRef<number | undefined>(undefined);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [addVersionOpen, setAddVersionOpen] = useState(false);
  const [newVersion, setNewVersion] = useState("");
  const [newArchive, setNewArchive] = useState<File | null>(null);
  const [pendingVersionId, setPendingVersionId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourceDirectory, setSourceDirectory] = useState("");
  const [tagPrefix, setTagPrefix] = useState("");
  const registryPath = `/app/${encodeURIComponent(orgName)}/registry`;

  useEffect((): (() => void) => {
    return (): void => {
      if (copiedResetTimerRef.current !== undefined) window.clearTimeout(copiedResetTimerRef.current);
    };
  }, []);

  useEffect((): (() => void) => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const path = `/organizations/${encodeURIComponent(orgName)}/registry-modules/private/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(provider)}`;
    void fetchApi(path, { signal: controller.signal })
      .then(async (response): Promise<void> => {
        if (controller.signal.reason !== undefined) return;
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const loadedModule = registryModuleFromResource((response as { data: JsonValue }).data);
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const versionResponse = await fetchApi(`/registry-modules/${encodeURIComponent(loadedModule.id)}/versions`, { signal: controller.signal }) as { data?: unknown[] };
        if (controller.signal.reason !== undefined) return;
        const loadedVersions = Array.isArray(versionResponse.data) ? versionResponse.data.map(registryModuleVersionFromResource) : [];
        setModule(loadedModule);
        setVersions(loadedVersions);
        setSourceDirectory(loadedModule.vcsRepo?.sourceDirectory ?? "");
        setTagPrefix(loadedModule.vcsRepo?.tagPrefix ?? "");
        const requested = searchParams.get("version");
        if (requested === null && loadedVersions[0] !== undefined) {
          const next = new URLSearchParams(searchParams);
          next.set("version", loadedVersions[0].version);
          setSearchParams(next, { replace: true });
        }
      })
      .catch((caught: unknown): void => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Module could not be loaded."); })
      .finally((): void => { if (!controller.signal.aborted) setLoading(false); });
    return (): void => { controller.abort(); };
  }, [name, namespace, orgName, provider, reload]); // search params are intentionally handled without refetching

  const selectedVersion = versions.find((version): boolean => version.version === searchParams.get("version")) ?? versions[0] ?? null;
  const metadata = selectedVersion?.metadata ?? null;
  const sections = useMemo((): RegistryModuleSection[] => metadata === null ? [] : [
    metadata,
    ...metadata.submodules,
    ...metadata.examples,
  ], [metadata]);
  const section = sections.find((candidate): boolean => candidate.path === sectionPath) ?? sections[0] ?? null;
  const host = typeof window === "undefined" ? "terrence.example.com" : window.location.host;
  const sourceAddress = `${host}/${namespace}/${name}/${provider}`;
  const alias = name.replace(/[^A-Za-z0-9_]/g, "_");
  const usage = section === null || selectedVersion === null ? "" : [
    `module ${JSON.stringify(alias)} {`,
    `  source  = ${JSON.stringify(sourceAddress)}`,
    `  version = ${JSON.stringify(selectedVersion.version)}`,
    ...section.inputs.filter((input): boolean => input.required).map((input): string => `\n  # ${input.name} = <${input.type}>`),
    "}",
  ].join("\n");
  const credentials = `credentials ${JSON.stringify(host)} {\n  token = "<TERRAFORM_API_TOKEN>"\n}`;

  const refresh = (): void => { setReload((value): number => value + 1); };
  const mutate = async (operation: () => Promise<unknown>, success: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      toast.add({ title: success, type: "success" });
      refresh();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "The module could not be updated.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string, kind: "config" | "credentials"): Promise<void> => {
    if (await copyTextToClipboard(value)) {
      setCopied(kind);
      if (copiedResetTimerRef.current !== undefined) window.clearTimeout(copiedResetTimerRef.current);
      copiedResetTimerRef.current = window.setTimeout((): void => {
        copiedResetTimerRef.current = undefined;
        setCopied(null);
      }, 1500);
      return;
    }
    toast.add({
      title: `Could not copy ${kind === "config" ? "configuration" : "credentials"}`,
      type: "error",
    });
  };

  const updateSelectedVersion = (version: string): void => {
    const next = new URLSearchParams(searchParams);
    next.set("version", version);
    setSearchParams(next);
    setSectionPath(".");
  };

  /** Arrow-left/right moves the active tab; the target is a sibling tab button. */
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (offset === 0) return;
    event.preventDefault();
    const targetIndex = (index + offset + tabs.length) % tabs.length;
    const next = tabs[targetIndex];
    if (next === undefined) return;
    setTab(next.id);
    // SAFETY: the tab buttons are the only children of the tablist; the
    // sibling at the computed index is the button to focus.
    (event.currentTarget.parentElement?.children[targetIndex] as HTMLElement | undefined)?.focus();
  };

  const discardPendingVersion = (): void => {
    const versionId = pendingVersionId;
    setPendingVersionId(null);
    if (versionId !== null) {
      void fetchApi(`/registry-module-versions/${encodeURIComponent(versionId)}`, { method: "DELETE" }).catch((): void => { return; });
    }
  };

  const publishVersion = async (): Promise<void> => {
    if (module === null || newVersion.trim() === "") return;
    if (module.publishingMechanism === "manual" && newArchive === null) {
      setError("Select a .tar.gz module archive.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let versionId = pendingVersionId;
      if (versionId === null) {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
        const response = await fetchApi(`/registry-modules/${encodeURIComponent(module.id)}/versions`, {
          method: "POST",
          body: JSON.stringify({ data: { type: "registry-module-versions", attributes: { version: newVersion.trim() } } }),
        }) as { data: { id: string } };
        versionId = response.data.id;
        setPendingVersionId(versionId);
      }
      if (module.publishingMechanism === "manual") {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
        const uploadResponse = await fetchApi(`/registry-module-versions/${encodeURIComponent(versionId)}/upload`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: newArchive,
        }) as { data: { attributes?: { status?: string } } };
        if (uploadResponse.data.attributes?.status !== "ok") throw new Error("The uploaded module archive was not accepted.");
      }
      setPendingVersionId(null);
      setAddVersionOpen(false);
      setNewVersion("");
      setNewArchive(null);
      refresh();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Version publication failed.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <PageShell><div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><Spinner />Loading module…</div></PageShell>;
  if (error !== null && module === null) return <PageShell><Empty className="min-h-64 border"><EmptyHeader><EmptyTitle>Module unavailable</EmptyTitle><EmptyDescription>{error}</EmptyDescription></EmptyHeader></Empty></PageShell>;
  if (module === null) return <PageShell><Empty><EmptyHeader><EmptyTitle>Module not found</EmptyTitle></EmptyHeader></Empty></PageShell>;

  const tabs: readonly Readonly<{ id: DetailTab; label: string; count?: number }>[] = [
    { id: "readme", label: "README" },
    { id: "inputs", label: "Inputs", count: section?.inputs.length ?? 0 },
    { id: "outputs", label: "Outputs", count: section?.outputs.length ?? 0 },
    { id: "dependencies", label: "Dependencies", count: (section?.providers.length ?? 0) + (section?.modules.length ?? 0) },
    { id: "resources", label: "Resources", count: section?.resources.length ?? 0 },
  ];

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="space-y-3">
          <Breadcrumbs items={[{ label: "Registry", to: registryPath }, { label: namespace }, { label: name }]} />
          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
            <div className="space-y-2"><h1 className="text-balance text-3xl font-bold tracking-tight text-foreground">{name}</h1><p className="text-sm text-muted-foreground">Published by {namespace}</p><code className="text-sm text-muted-foreground">{namespace}/{name}/{provider}</code><div className="flex flex-wrap gap-2"><Badge variant="outline">Private</Badge><Badge variant="secondary">{provider}</Badge><Badge variant="secondary">{publishingLabel(module)}</Badge>{selectedVersion?.deprecated === true && <Badge variant="outline">Deprecated</Badge>}{selectedVersion?.revoked === true && <Badge variant="destructive">Revoked</Badge>}</div></div>
            <div className="flex flex-wrap gap-2">
              {module.permissions.canResync && <Button type="button" variant="outline" disabled={busy} onClick={(): void => { void mutate(async (): Promise<unknown> => await fetchApi(`/registry-modules/${module.id}/actions/resync`, { method: "POST" }), "Registry synchronized"); }}><RefreshCw aria-hidden="true" />Resync</Button>}
              {module.permissions.canDelete && <Button type="button" variant="outline" onClick={(): void => { setSettingsOpen(true); }}><Settings2 aria-hidden="true" />Settings</Button>}
              {module.permissions.canDelete && module.publishingWorkflow !== "tag" && <Button type="button" onClick={(): void => { setAddVersionOpen(true); }}>Add version</Button>}
            </div>
          </div>
          {module.lastSyncError !== null && <div role="alert" className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{module.lastSyncError}</div>}
          {selectedVersion?.ingestError != null && <div role="alert" className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{selectedVersion.ingestError}</div>}
        </div>

        {error !== null && <FieldError>{error}</FieldError>}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-5">
            <Card size="sm"><CardContent className="grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-4"><div><p className="text-xs text-muted-foreground">Version</p><Select aria-label="Select module version" value={selectedVersion?.version ?? ""} onValueChange={updateSelectedVersion}>{versions.map((version): React.JSX.Element => <SelectItem key={version.id} value={version.version}>{version.version}{version.revoked ? " · revoked" : version.deprecated ? " · deprecated" : ""}</SelectItem>)}</Select></div><div><p className="text-xs text-muted-foreground">Published</p><p className="mt-2 text-sm">{dateLabel(selectedVersion?.publishedAt ?? null)}</p></div><div><p className="text-xs text-muted-foreground">Revision</p><p className="mt-2 truncate font-mono text-sm" title={selectedVersion?.commitSha ?? undefined}>{selectedVersion?.tag ?? selectedVersion?.branch ?? selectedVersion?.commitSha?.slice(0, 12) ?? "Manual upload"}</p></div><div><p className="text-xs text-muted-foreground">Repository</p>{module.vcsRepo?.repositoryUrl != null ? <a className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline" href={module.vcsRepo.repositoryUrl} target="_blank" rel="noreferrer">{module.vcsRepo.displayIdentifier ?? module.vcsRepo.identifier}<ExternalLink aria-hidden="true" className="size-3" /></a> : <p className="mt-2 text-sm">Terrence API</p>}</div></CardContent></Card>

            {sections.length > 1 && <Field><FieldLabel htmlFor="module-section">Documentation section</FieldLabel><Select id="module-section" value={section?.path ?? "."} onValueChange={setSectionPath}>{sections.map((item): React.JSX.Element => <SelectItem value={item.path} key={item.path}>{item.path === "." ? "Root module" : item.path.startsWith("modules/") ? `Submodule · ${item.path.slice(8)}` : `Example · ${item.path.slice(9)}`}</SelectItem>)}</Select></Field>}

            <div role="tablist" aria-label="Module documentation" className="flex gap-1 overflow-x-auto border-b">
              {tabs.map((item, index): React.JSX.Element => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring", tab === item.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")} onClick={(): void => { setTab(item.id); }} onKeyDown={(event): void => { handleTabKeyDown(event, index); }}>{item.label}{item.count === undefined ? "" : ` (${item.count})`}</button>)}
            </div>

            <div role="tabpanel" className="min-h-48">
              {section === null ? <Empty><EmptyHeader><EmptyTitle>No metadata</EmptyTitle><EmptyDescription>This version has not produced registry documentation.</EmptyDescription></EmptyHeader></Empty> : tab === "readme" ? (section.readme === "" ? <p className="text-sm text-muted-foreground">No README was published for this section.</p> : <MarkdownContent markdown={section.readme} />) : tab === "inputs" ? <div className="space-y-3">{section.inputs.map((input): React.JSX.Element => <Card size="sm" key={input.name}><CardHeader><CardTitle className="flex flex-wrap items-center gap-2 font-mono text-sm">{input.name}<Badge variant={input.required ? "default" : "outline"}>{input.required ? "Required" : "Optional"}</Badge>{input.sensitive && <Badge variant="outline">Sensitive</Badge>}</CardTitle><CardDescription>{input.description ?? "No description."}</CardDescription></CardHeader><CardContent className="grid gap-2 text-xs sm:grid-cols-2"><div><span className="text-muted-foreground">Type</span><pre className="mt-1 overflow-x-auto rounded bg-muted p-2">{input.type}</pre></div>{!input.required && <div><span className="text-muted-foreground">Default</span><pre className="mt-1 max-h-28 overflow-auto rounded bg-muted p-2">{displayDefault(input.defaultValue)}</pre></div>}</CardContent></Card>)}</div> : tab === "outputs" ? <div className="space-y-3">{section.outputs.map((output): React.JSX.Element => <Card size="sm" key={output.name}><CardHeader><CardTitle className="flex items-center gap-2 font-mono text-sm">{output.name}{output.sensitive && <Badge variant="outline">Sensitive</Badge>}</CardTitle><CardDescription>{output.description ?? "No description."}</CardDescription></CardHeader></Card>)}</div> : tab === "dependencies" ? <div className="grid gap-4 md:grid-cols-2"><Card size="sm"><CardHeader><CardTitle>Providers</CardTitle></CardHeader><CardContent className="space-y-3">{section.providers.length === 0 ? <p className="text-sm text-muted-foreground">No provider requirements.</p> : section.providers.map((dependency): React.JSX.Element => <div key={dependency.name}><code>{dependency.source ?? dependency.name}</code><p className="text-xs text-muted-foreground">{dependency.versionConstraint ?? "No version constraint"}</p></div>)}</CardContent></Card><Card size="sm"><CardHeader><CardTitle>Child modules</CardTitle></CardHeader><CardContent className="space-y-3">{section.modules.length === 0 ? <p className="text-sm text-muted-foreground">No child modules.</p> : section.modules.map((dependency): React.JSX.Element => <div key={dependency.name}><code>{dependency.name}</code><p className="break-all text-xs text-muted-foreground">{dependency.source ?? "Local source"}{dependency.versionConstraint === null ? "" : ` · ${dependency.versionConstraint}`}</p></div>)}</CardContent></Card></div> : <div className="space-y-2">{section.resources.map((resource): React.JSX.Element => <div key={`${resource.mode}-${resource.type}-${resource.name}`} className="flex items-center justify-between rounded-md border p-3"><code className="text-sm">{resource.type}.{resource.name}</code><Badge variant="outline">{resource.mode === "data" ? "Data source" : "Managed"}</Badge></div>)}</div>}
            </div>
          </div>

          <aside className="space-y-4">
            <Card><CardHeader><CardTitle>Use this module</CardTitle><CardDescription>Pin the selected version in Terraform or OpenTofu.</CardDescription></CardHeader><CardContent className="space-y-3"><pre className="overflow-x-auto rounded-md bg-code-background p-3 text-xs text-code-foreground"><code>{usage}</code></pre><Button type="button" variant="outline" className="w-full" onClick={(): void => { void copy(usage, "config"); }}>{copied === "config" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied === "config" ? "Copied" : "Copy configuration"}</Button></CardContent></Card>
            <Card><CardHeader><CardTitle>CLI credentials</CardTitle><CardDescription>Use a personal API token locally. Terrence workers receive scoped run credentials automatically.</CardDescription></CardHeader><CardContent className="space-y-3"><pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs"><code>{credentials}</code></pre><Button type="button" variant="outline" className="w-full" onClick={(): void => { void copy(credentials, "credentials"); }}>{copied === "credentials" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied === "credentials" ? "Copied" : "Copy credentials block"}</Button><Link className="block text-center text-sm text-primary hover:underline" to="/app/account#api-tokens">Manage personal API tokens</Link></CardContent></Card>
            {module.permissions.canDelete && selectedVersion !== null && (
              <Card>
                <CardHeader><CardTitle>Manage version</CardTitle></CardHeader>
                <CardContent className="grid gap-2">
                  <Button type="button" variant="outline" disabled={busy || selectedVersion.revoked} onClick={(): void => { void mutate(async (): Promise<unknown> => await fetchApi(`/registry-module-versions/${selectedVersion.id}`, { method: "PATCH", body: JSON.stringify({ data: { type: "registry-module-versions", attributes: { deprecated: !selectedVersion.deprecated } } }) }), selectedVersion.deprecated ? "Deprecation reverted" : "Version deprecated"); }}>{selectedVersion.deprecated ? "Revert deprecation" : "Deprecate"}</Button>
                  <Button type="button" variant="outline" disabled={busy} onClick={(): void => { if (selectedVersion.revoked) { void mutate(async (): Promise<unknown> => await fetchApi(`/registry-module-versions/${selectedVersion.id}/actions/revert-revocation`, { method: "POST" }), "Revocation reverted"); } else { setConfirmation("revoke"); } }}>{selectedVersion.revoked ? "Revert revocation" : "Revoke"}</Button>
                  <Button type="button" variant="outline" disabled={busy || selectedVersion.status !== "ok"} onClick={(): void => { void mutate(async (): Promise<unknown> => await fetchApi(`/registry-modules/${module.id}/versions/${selectedVersion.version}/actions/test`, { method: "POST" }), "Module tests completed"); }}>Run tests</Button>
                  <Button type="button" variant="destructive" onClick={(): void => { setConfirmation("delete-version"); }}>Delete version</Button>
                  <Button type="button" variant="destructive" onClick={(): void => { setConfirmation("delete-module"); }}>Delete module</Button>
                </CardContent>
              </Card>
            )}
          </aside>
        </div>
      </div>

      <Dialog open={addVersionOpen} onOpenChange={(open): void => { setAddVersionOpen(open); if (!open && !busy) { discardPendingVersion(); setNewVersion(""); setNewArchive(null); } }}><DialogContent><DialogHeader><DialogTitle>Add module version</DialogTitle><DialogDescription>{// SAFETY: the rendered attribute matches the union the UI derives from the API contract.
module.publishingMechanism === "manual" ? "Upload a real archive for a new semantic version." : "Publish the current configured branch revision as a new semantic version."}</DialogDescription></DialogHeader><FieldGroup><Field><FieldLabel htmlFor="detail-new-version">Version</FieldLabel><Input id="detail-new-version" value={newVersion} onChange={(event): void => { setNewVersion(event.target.value); }} placeholder="1.1.0" disabled={pendingVersionId !== null} /></Field>{module.publishingMechanism === "manual" && <Field><FieldLabel htmlFor="detail-new-archive">Module archive</FieldLabel><Input id="detail-new-archive" type="file" accept=".tar.gz,application/gzip" onChange={(event): void => { setNewArchive(event.target.files?.[0] ?? null); }} /></Field>}</FieldGroup><DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={(): void => { discardPendingVersion(); setAddVersionOpen(false); setNewVersion(""); setNewArchive(null); }}>Cancel</Button><Button type="button" disabled={busy} onClick={(): void => { void publishVersion(); }}>{busy ? "Publishing…" : pendingVersionId === null ? "Publish version" : "Retry upload"}</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}><DialogContent><DialogHeader><DialogTitle>Publication settings</DialogTitle><DialogDescription>Workflow transitions are intentionally disabled because they change release semantics.</DialogDescription></DialogHeader><FieldGroup><Field><FieldLabel>VCS connection</FieldLabel><Input value={module.vcsRepo?.displayIdentifier ?? "Manual / API"} disabled /></Field><Field><FieldLabel htmlFor="detail-source-directory">Source directory</FieldLabel><Input id="detail-source-directory" value={sourceDirectory} onChange={(event): void => { setSourceDirectory(event.target.value); }} disabled={module.publishingMechanism !== "vcs"} /></Field>{module.publishingWorkflow === "tag" && <Field><FieldLabel htmlFor="detail-tag-prefix">Tag prefix</FieldLabel><Input id="detail-tag-prefix" value={tagPrefix} onChange={(event): void => { setTagPrefix(event.target.value); }} /></Field>}<FieldDescription>Last successful sync: {dateLabel(module.lastSuccessfulSyncAt)}</FieldDescription></FieldGroup><DialogFooter><Button type="button" variant="outline" onClick={(): void => { setSettingsOpen(false); }}>Cancel</Button><Button type="button" disabled={busy || module.publishingMechanism !== "vcs"} onClick={(): void => { void mutate(async (): Promise<void> => { await fetchApi(`/organizations/${encodeURIComponent(orgName)}/registry-modules/private/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(provider)}`, { method: "PATCH", body: JSON.stringify({ data: { type: "registry-modules", attributes: { "source-directory": sourceDirectory, "tag-prefix": tagPrefix } } }) }); setSettingsOpen(false); }, "Publication settings saved"); }}>Save</Button></DialogFooter></DialogContent></Dialog>

      <ConfirmDialog open={confirmation !== null} onOpenChange={(open): void => { if (!open) setConfirmation(null); }} title={confirmation === "delete-module" ? "Delete module" : confirmation === "delete-version" ? "Delete version" : "Revoke version"} description={confirmation === "revoke" ? "Revoked versions are removed from Terraform version discovery and cannot be downloaded." : "This permanently removes the selected registry artifact."} confirmText={confirmation === "revoke" ? "Revoke version" : "Delete"} onConfirm={async (): Promise<void> => {
        if (selectedVersion === null) return;
        if (confirmation === "revoke") await mutate(async (): Promise<unknown> => await fetchApi(`/registry-module-versions/${selectedVersion.id}/actions/revoke`, { method: "POST" }), "Version revoked");
        if (confirmation === "delete-version") await mutate(async (): Promise<unknown> => await fetchApi(`/registry-module-versions/${selectedVersion.id}`, { method: "DELETE" }), "Version deleted");
        if (confirmation === "delete-module") { setBusy(true); await fetchApi(`/registry-modules/${module.id}`, { method: "DELETE" }); await navigate(registryPath); }
        setConfirmation(null);
      }} loading={busy} />
    </PageShell>
  );
}