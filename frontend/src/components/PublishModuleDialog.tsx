import { Fragment, useEffect, useMemo, useState } from "react";
import { FileArchive, GitBranch } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { VcsRepoSelector } from "./VcsRepoSelector";
import { loadOrganizationVcsConnections, type VcsConnection } from "./WorkspaceVcs";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "./ui/field";
import { Input } from "./ui/input";
import { Select, SelectItem } from "./ui/select";
import { fetchApi } from "../lib/api";
import { registryModuleFromResource, registryModulePath } from "../lib/registry";
import { cn } from "../lib/utils";

type Repository = Readonly<{ identifier: string; name: string; owner?: string }>;
type SourceKind = "vcs" | "manual";
type Workflow = "tag" | "branch";

export function PublishModuleDialog({
  open,
  orgName,
  onOpenChange,
}: Readonly<{
  open: boolean;
  orgName: string;
  onOpenChange: (open: boolean) => void;
}>): React.JSX.Element {
  const navigate = useNavigate();
  const [source, setSource] = useState<SourceKind>("vcs");
  const [workflow, setWorkflow] = useState<Workflow>("tag");
  const [connections, setConnections] = useState<VcsConnection[]>([]);
  const [connection, setConnection] = useState("");
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repository, setRepository] = useState("");
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [sourceDirectory, setSourceDirectory] = useState("");
  const [tagPrefix, setTagPrefix] = useState("");
  const [branch, setBranch] = useState("main");
  const [version, setVersion] = useState("1.0.0");
  const [archive, setArchive] = useState<File | null>(null);
  const [manualTarget, setManualTarget] = useState<Readonly<{ moduleId: string; versionId: string }> | null>(null);
  const [loadingConnections, setLoadingConnections] = useState(false);
  const [loadingRepositories, setLoadingRepositories] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");

  useEffect((): (() => void) | undefined => {
    if (!open || source !== "vcs") return undefined;
    const controller = new AbortController();
    setLoadingConnections(true);
    setError("");
    void loadOrganizationVcsConnections(orgName, controller.signal)
      .then((loaded): void => { if (!controller.signal.aborted) setConnections(loaded); })
      .catch((caught: unknown): void => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "VCS connections could not be loaded.");
      })
      .finally((): void => { if (!controller.signal.aborted) setLoadingConnections(false); });
    return (): void => { controller.abort(); };
  }, [open, orgName, source]);

  useEffect((): (() => void) | undefined => {
    setRepositories([]);
    setRepository("");
    if (!open || source !== "vcs" || connection === "") return undefined;
    const controller = new AbortController();
    setLoadingRepositories(true);
    void fetchApi(
      `/organizations/${encodeURIComponent(orgName)}/vcs-connections/${encodeURIComponent(connection)}/repositories`,
      { signal: controller.signal },
    ).then((response): void => {
      if (controller.signal.aborted) return;
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const data: unknown = (response as { data?: unknown }).data;
      const rows: unknown[] = Array.isArray(data) ? data : [];
      setRepositories(rows.flatMap((item): Repository[] => {
        if (item === null || typeof item !== "object") return [];
// SAFETY: the fixture object is read as a record; each field is typed below.
        const attributes: unknown = (item as Record<string, unknown>)["attributes"];
        if (attributes === null || typeof attributes !== "object") return [];
// SAFETY: the fixture object is read as a record; each field is typed below.
        const repository = attributes as Record<string, unknown>;
        if (typeof repository["identifier"] !== "string" || typeof repository["name"] !== "string") return [];
        return [{ identifier: repository["identifier"], name: repository["name"], ...(typeof repository["owner"] === "string" ? { owner: repository["owner"] } : undefined) }];
      }));
    }).catch((caught: unknown): void => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Repositories could not be loaded.");
    }).finally((): void => { if (!controller.signal.aborted) setLoadingRepositories(false); });
    return (): void => { controller.abort(); };
  }, [connection, open, orgName, source]);

  const selectedConnection = useMemo(
    (): VcsConnection | undefined => connections.find((candidate): boolean => candidate.value === connection),
    [connection, connections],
  );

  const reset = (): void => {
    setSource("vcs");
    setWorkflow("tag");
    setConnection("");
    setRepository("");
    setName("");
    setProvider("");
    setSourceDirectory("");
    setTagPrefix("");
    setBranch("main");
    setVersion("1.0.0");
    setArchive(null);
    setManualTarget(null);
    setError("");
  };

  const discardManualTarget = (): void => {
    const target = manualTarget;
    setManualTarget(null);
    if (target !== null) {
      void fetchApi(`/registry-modules/${encodeURIComponent(target.moduleId)}`, { method: "DELETE" }).catch((): void => { return; });
    }
  };

  const finish = async (resource: unknown): Promise<void> => {
    const module = registryModuleFromResource(resource);
    reset();
    onOpenChange(false);
    await navigate(registryModulePath(orgName, module));
  };

  const publishVcs = async (): Promise<void> => {
    if (selectedConnection === undefined || repository.trim() === "" || name.trim() === "" || provider.trim() === "") {
      setError("Select a VCS connection and repository, then enter the module name and provider.");
      return;
    }
    if (workflow === "branch" && (branch.trim() === "" || version.trim() === "")) {
      setError("Branch and initial version are required for branch-based publishing.");
      return;
    }
    const vcsRepo = {
      identifier: repository.trim(),
      "display-identifier": repository.trim(),
      ...(selectedConnection.kind === "github-app"
        ? { "github-app-installation-id": selectedConnection.id }
        : { "oauth-token-id": selectedConnection.id }),
      ...(workflow === "branch" ? { branch: branch.trim() } : undefined),
    };
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
    const response = await fetchApi(`/organizations/${encodeURIComponent(orgName)}/registry-modules/vcs`, {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "registry-modules",
          attributes: {
            "vcs-repo": vcsRepo,
            "module-name": name.trim(),
            "module-provider": provider.trim(),
            "source-directory": sourceDirectory.trim(),
            "tag-prefix": workflow === "tag" ? tagPrefix.trim() : "",
            ...(workflow === "branch" ? { version: version.trim() } : undefined),
          },
        },
      }),
    }) as { data: unknown };
    await finish(response.data);
  };

  const publishManual = async (): Promise<void> => {
    if (name.trim() === "" || provider.trim() === "" || version.trim() === "" || archive === null) {
      setError("Name, provider, version, and a .tar.gz archive are required.");
      return;
    }
    if (!archive.name.toLocaleLowerCase().endsWith(".tar.gz")) {
      setError("Select a gzip-compressed tar archive ending in .tar.gz.");
      return;
    }
    let target = manualTarget;
    if (target === null) {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const moduleResponse = await fetchApi(`/organizations/${encodeURIComponent(orgName)}/registry-modules`, {
        method: "POST",
        body: JSON.stringify({
          data: { type: "registry-modules", attributes: { name: name.trim(), provider: provider.trim(), "registry-name": "private" } },
        }),
      }) as { data: { id: string } };
      try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
        const versionResponse = await fetchApi(`/registry-modules/${encodeURIComponent(moduleResponse.data.id)}/versions`, {
          method: "POST",
          body: JSON.stringify({ data: { type: "registry-module-versions", attributes: { version: version.trim() } } }),
        }) as { data: { id: string } };
        target = { moduleId: moduleResponse.data.id, versionId: versionResponse.data.id };
        setManualTarget(target);
      } catch (caught: unknown) {
        await fetchApi(`/registry-modules/${encodeURIComponent(moduleResponse.data.id)}`, { method: "DELETE" }).catch((): void => { return; });
        throw caught;
      }
    }
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
    const uploadResponse = await fetchApi(`/registry-module-versions/${encodeURIComponent(target.versionId)}/upload`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: archive,
    }) as { data: { attributes?: { status?: string } } };
    if (uploadResponse.data.attributes?.status !== "ok") throw new Error("The uploaded module archive was not accepted.");
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
    const detail = await fetchApi(`/registry-modules/${encodeURIComponent(target.moduleId)}`) as { data: unknown };
    await finish(detail.data);
  };

  const publish = async (): Promise<void> => {
    setPublishing(true);
    setError("");
    try {
      if (source === "vcs") await publishVcs();
      else await publishManual();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "The module could not be published.");
    } finally {
      setPublishing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next): void => {
      onOpenChange(next);
      if (!next && !publishing) { discardManualTarget(); reset(); }
    }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Publish module</DialogTitle>
          <DialogDescription>Store real, reusable module source in this private registry.</DialogDescription>
        </DialogHeader>

        <FieldSet>
          <FieldLegend>Source</FieldLegend>
          <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Module source">
            {([
              { value: "vcs", title: "VCS repository", description: "Recommended · sync semantic tags or a branch", icon: GitBranch },
              { value: "manual", title: "Module archive", description: "Upload a real .tar.gz release", icon: FileArchive },
            ] as const).map((option): React.JSX.Element => (
              <label key={option.value} className={cn(
                "flex cursor-pointer gap-3 rounded-lg border p-3 outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                source === option.value && "border-primary bg-primary/5",
              )}>
                <input
                  className="mt-1"
                  type="radio"
                  name="module-source"
                  value={option.value}
                  checked={source === option.value}
                  onChange={(): void => { discardManualTarget(); setSource(option.value); setError(""); }}
                />
                <option.icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span><span className="block text-sm font-medium">{option.title}</span><span className="text-xs text-muted-foreground">{option.description}</span></span>
              </label>
            ))}
          </div>
        </FieldSet>

        <FieldGroup>
          {source === "vcs" && (
            <>
              <Field>
                <FieldLabel htmlFor="module-vcs-connection">VCS connection</FieldLabel>
                <Select id="module-vcs-connection" value={connection} onValueChange={setConnection} disabled={loadingConnections || publishing}>
                  <SelectItem value="">{loadingConnections ? "Loading connections…" : "Select a connection"}</SelectItem>
                  {connections.map((candidate): React.JSX.Element => <SelectItem key={candidate.value} value={candidate.value}>{candidate.label}</SelectItem>)}
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="module-vcs-repository">Repository</FieldLabel>
                <VcsRepoSelector
                  id="module-vcs-repository"
                  value={repository}
                  onValueChange={setRepository}
                  repositories={repositories}
                  loading={loadingRepositories}
                  disabled={connection === "" || publishing}
                />
              </Field>
              <FieldSet>
                <FieldLegend variant="label">Publishing workflow</FieldLegend>
                <div className="flex flex-wrap gap-5" role="radiogroup" aria-label="Publishing workflow">
                  <label className="flex items-center gap-2 text-sm"><input type="radio" name="workflow" checked={workflow === "tag"} onChange={(): void => { setWorkflow("tag"); }} />Tag-based</label>
                  <label className="flex items-center gap-2 text-sm"><input type="radio" name="workflow" checked={workflow === "branch"} onChange={(): void => { setWorkflow("branch"); }} />Branch-based</label>
                </div>
              </FieldSet>
            </>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field><FieldLabel htmlFor="module-name">Module name</FieldLabel><Input id="module-name" value={name} onInput={(event): void => { setName(event.currentTarget.value); }} placeholder="networking-spoke" disabled={publishing || manualTarget !== null} /></Field>
            <Field><FieldLabel htmlFor="module-provider">Provider</FieldLabel><Input id="module-provider" value={provider} onInput={(event): void => { setProvider(event.currentTarget.value); }} placeholder="azurerm" disabled={publishing || manualTarget !== null} /></Field>
          </div>

          {source === "vcs" ? (
            <Fragment key="vcs-fields">
              <Field><FieldLabel htmlFor="module-source-directory">Source directory</FieldLabel><Input id="module-source-directory" value={sourceDirectory} onInput={(event): void => { setSourceDirectory(event.currentTarget.value); }} placeholder="modules/networking-spoke" disabled={publishing} /><FieldDescription>Leave empty when the module is at repository root.</FieldDescription></Field>
              {workflow === "tag" ? (
                <Field><FieldLabel htmlFor="module-tag-prefix">Tag prefix</FieldLabel><Input id="module-tag-prefix" value={tagPrefix} onInput={(event): void => { setTagPrefix(event.currentTarget.value); }} placeholder="networking-v" disabled={publishing} /><FieldDescription>Empty accepts 1.2.3 and v1.2.3. A monorepo prefix can be networking-v.</FieldDescription></Field>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field><FieldLabel htmlFor="module-branch">Branch</FieldLabel><Input id="module-branch" value={branch} onInput={(event): void => { setBranch(event.currentTarget.value); }} disabled={publishing} /></Field>
                  <Field><FieldLabel htmlFor="module-initial-version">Initial version</FieldLabel><Input id="module-initial-version" value={version} onInput={(event): void => { setVersion(event.currentTarget.value); }} placeholder="1.0.0" disabled={publishing} /></Field>
                </div>
              )}
            </Fragment>
          ) : (
            <Fragment key="manual-fields">
              <Field><FieldLabel htmlFor="module-version">Version</FieldLabel><Input id="module-version" value={version} onInput={(event): void => { setVersion(event.currentTarget.value); }} placeholder="1.0.0" disabled={publishing || manualTarget !== null} /></Field>
              <Field><FieldLabel htmlFor="module-archive">Module archive</FieldLabel><Input id="module-archive" type="file" accept=".tar.gz,application/gzip" disabled={publishing} onChange={(event): void => { setArchive(event.target.files?.[0] ?? null); }} /><FieldDescription>The module must be at the archive root or inside one top-level directory.</FieldDescription></Field>
            </Fragment>
          )}
        </FieldGroup>

        {error !== "" && <FieldError>{error}</FieldError>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={publishing} onClick={(): void => { discardManualTarget(); onOpenChange(false); reset(); }}>Cancel</Button>
          <Button type="button" disabled={publishing} onClick={publish}>{publishing ? "Publishing…" : source === "vcs" ? "Publish from VCS" : manualTarget === null ? "Upload module" : "Retry upload"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
