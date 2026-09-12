import { EmptyState } from "../components/EmptyState";
import { Select } from "../components/ui/select";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Spinner } from "../components/ui/spinner";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { useOrganizationPermissions } from "../hooks/useOrganizationPermissions";
import { Layers, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";
import { isString } from "../lib/type-guards";

type VcsRepo = {
  identifier?: string;
  branch?: string | null;
  "service-provider"?: string | null;
  "display-identifier"?: string | null;
  "repository-http-url"?: string | null;
  "tags-regex"?: string | null;
  "sparse-checkout-pattern"?: string | null;
  "trigger-disabled"?: boolean;
} | null;

type Stack = {
  id: string;
  attributes: {
    name: string;
    description?: string;
    "vcs-repo"?: VcsRepo;
    "working-directory"?: string | null;
    "speculative-enabled"?: boolean;
    "trigger-disabled"?: boolean;
    "debugging-mode"?: boolean;
    "execution-mode"?: "remote" | "agent";
    "created-at"?: string;
  };
  relationships?: { "agent-pool"?: { data?: { id?: string } | null } };
};

type Project = { id: string; attributes: { name: string } };
type AgentPool = { id: string; attributes: { name?: string } };
type StackConfiguration = { id: string; attributes: { status?: string; "sequence-number"?: number } };
type LatestConfiguration = StackConfiguration | null | "error" | "loading";

type StackForm = {
  name: string;
  projectId: string;
  agentPoolId: string;
  description: string;
  workingDirectory: string;
  vcsIdentifier: string;
  vcsBranch: string;
  vcsServiceProvider: string;
  vcsDisplayIdentifier: string;
  vcsRepositoryHttpUrl: string;
  vcsTagsRegex: string;
  vcsSparseCheckoutPattern: string;
  triggerDisabled: boolean;
  debuggingMode: boolean;
  executionMode: "remote" | "agent";
  speculative: boolean;
};

const emptyForm: StackForm = {
  name: "",
  projectId: "",
  agentPoolId: "",
  description: "",
  workingDirectory: "",
  vcsIdentifier: "",
  vcsBranch: "",
  vcsServiceProvider: "github",
  vcsDisplayIdentifier: "",
  vcsRepositoryHttpUrl: "",
  vcsTagsRegex: "",
  vcsSparseCheckoutPattern: "",
  triggerDisabled: false,
  debuggingMode: false,
  executionMode: "remote",
  speculative: false,
};

function vcsRepo(stack: Stack): VcsRepo {
  return stack.attributes["vcs-repo"] ?? null;
}

function stackHasVcsRemote(stack: Stack): boolean {
  const repo = vcsRepo(stack);
  return ((repo?.identifier ?? "").trim()) !== "" || ((repo?.["repository-http-url"] ?? "").trim()) !== "";
}

function stackVcsFormFields(repo: VcsRepo): Pick<StackForm,
  "vcsIdentifier" | "vcsBranch" | "vcsServiceProvider" | "vcsDisplayIdentifier" | "vcsRepositoryHttpUrl" | "vcsTagsRegex" | "vcsSparseCheckoutPattern"
> {
  return {
    vcsIdentifier: repo?.identifier ?? "",
    vcsBranch: repo?.branch ?? "",
    vcsServiceProvider: repo?.["service-provider"] ?? "github",
    vcsDisplayIdentifier: repo?.["display-identifier"] ?? "",
    vcsRepositoryHttpUrl: repo?.["repository-http-url"] ?? "",
    vcsTagsRegex: repo?.["tags-regex"] ?? "",
    vcsSparseCheckoutPattern: repo?.["sparse-checkout-pattern"] ?? "",
  };
}

function stackFormFromStack(stack: Stack): StackForm {
  return {
    name: stack.attributes.name,
    projectId: "",
    agentPoolId: stack.relationships?.["agent-pool"]?.data?.id ?? "",
    description: stack.attributes.description ?? "",
    workingDirectory: stack.attributes["working-directory"] ?? "",
    ...stackVcsFormFields(vcsRepo(stack)),
    triggerDisabled: stack.attributes["trigger-disabled"] === true || vcsRepo(stack)?.["trigger-disabled"] === true,
    debuggingMode: stack.attributes["debugging-mode"] === true,
    executionMode: stack.attributes["execution-mode"] === "agent" ? "agent" : "remote",
    speculative: stack.attributes["speculative-enabled"] === true,
  };
}

function validateStackForm(form: StackForm, isEditing: boolean): string | null {
  if (form.name.trim() === "") return "A stack name is required.";
  if (form.executionMode === "agent" && form.agentPoolId === "") return "Select an agent pool for agent execution.";
  if (!isEditing && form.projectId === "") return "A project is required.";
  return null;
}

function stackVcsPayload(form: StackForm): Record<string, unknown> | undefined {
  const vcsIdentifier = form.vcsIdentifier.trim();
  const vcsBranch = form.vcsBranch.trim();
  const vcsServiceProvider = form.vcsServiceProvider.trim();
  const vcsDisplayIdentifier = form.vcsDisplayIdentifier.trim();
  const vcsRepositoryHttpUrl = form.vcsRepositoryHttpUrl.trim();
  const vcsTagsRegex = form.vcsTagsRegex.trim();
  const vcsSparseCheckoutPattern = form.vcsSparseCheckoutPattern.trim();
  // Only send vcs-repo when an identifier is supplied, otherwise omit it
  // (an empty object would otherwise clear/override the stored VCS values).
  if (vcsIdentifier === "" && vcsRepositoryHttpUrl === "") return undefined;
  return {
    ...(vcsIdentifier === "" ? undefined : { identifier: vcsIdentifier }),
    ...(vcsServiceProvider === "" ? undefined : { "service-provider": vcsServiceProvider }),
    ...(vcsBranch === "" ? undefined : { branch: vcsBranch }),
    ...(vcsDisplayIdentifier === "" ? undefined : { "display-identifier": vcsDisplayIdentifier }),
    ...(vcsRepositoryHttpUrl === "" ? undefined : { "repository-http-url": vcsRepositoryHttpUrl }),
    ...(vcsTagsRegex === "" ? undefined : { "tags-regex": vcsTagsRegex }),
    ...(vcsSparseCheckoutPattern === "" ? undefined : { "sparse-checkout-pattern": vcsSparseCheckoutPattern }),
    "trigger-disabled": form.triggerDisabled,
  };
}

function stackSubmitAttributes(form: StackForm, editingStack: Stack | null): Record<string, unknown> {
  const vcs = stackVcsPayload(form);
  const originalVcs = editingStack?.attributes["vcs-repo"];
  const originalVcsConfigured = (originalVcs?.identifier ?? "").trim() !== ""
    || (originalVcs?.["repository-http-url"] ?? "").trim() !== "";
  return {
    name: form.name.trim(),
    description: form.description,
    "working-directory": form.workingDirectory === "" ? (editingStack === null ? undefined : form.workingDirectory) : form.workingDirectory,
    "speculative-enabled": form.speculative,
    "trigger-disabled": form.triggerDisabled,
    "debugging-mode": form.debuggingMode,
    "execution-mode": form.executionMode,
    ...(vcs === undefined
      ? (editingStack !== null && originalVcsConfigured
        // Editing a stack that currently has a VCS repo but the identifier was
        // cleared: explicitly clear the stored VCS config.
        ? { "vcs-repo": null }
        : undefined)
      : { "vcs-repo": vcs }),
  };
}

function StackTriggerFlags({ stack }: Readonly<{ stack: Stack }>): React.JSX.Element | null {
  const triggersDisabled = stack.attributes["trigger-disabled"] === true || vcsRepo(stack)?.["trigger-disabled"] === true;
  const debugging = stack.attributes["debugging-mode"] === true;
  if (!triggersDisabled && !debugging) return null;
  return (
    <div className="text-xs">{triggersDisabled ? "Triggers disabled" : ""}{triggersDisabled && debugging ? " · " : ""}{debugging ? "Debugging" : ""}</div>
  );
}

function StackLatestCell({ latest, canManage, busy, onPrepare }: Readonly<{
  latest: LatestConfiguration | undefined;
  canManage: boolean;
  busy: boolean;
  onPrepare: () => void;
}>): React.JSX.Element {
  if (latest === "loading" || latest === undefined) return <span>Loading…</span>;
  if (latest === "error") return <span>Unavailable</span>;
  if (latest === null) {
    return canManage
      ? <Button variant="outline" size="sm" onClick={onPrepare} disabled={busy}>Prepare</Button>
      : <span>—</span>;
  }
  return <span>#{latest.attributes["sequence-number"] ?? "—"} · {latest.attributes.status ?? "pending"}</span>;
}

function StackFormDialog({
  open,
  onOpenChange,
  editingStack,
  form,
  projects,
  agentPools,
  agentPoolsAvailable,
  saving,
  onField,
  updateForm,
  onSubmit,
  onCancel,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingStack: Stack | null;
  form: StackForm;
  projects: Project[];
  agentPools: AgentPool[];
  agentPoolsAvailable: boolean;
  saving: boolean;
  onField: (key: keyof StackForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  updateForm: (updater: (prev: StackForm) => StackForm) => void;
  onSubmit: () => void;
  onCancel: () => void;
}>): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editingStack === null ? "Create stack" : `Edit ${editingStack.attributes.name}`}</DialogTitle>
          <DialogDescription>
            {editingStack === null
              ? "Create a new stack. The project is required."
              : "Update this stack's configuration."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="stack-name">Name</Label>
            <Input id="stack-name" name="name" autoComplete="off" spellCheck={false} value={form.name} onChange={onField("name")} placeholder="my-stack…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stack-project">Project</Label>
            <Select
              id="stack-project"
              name="project"
              value={form.projectId}
              onChange={onField("projectId")}

              disabled={editingStack !== null}
            >
              <option value="">Select a project</option>
              {projects.map((project): React.JSX.Element => (
                <option key={project.id} value={project.id}>{project.attributes.name}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stack-vcs">VCS repository identifier</Label>
            <Input id="stack-vcs" name="vcs-repository" autoComplete="off" spellCheck={false} value={form.vcsIdentifier} onChange={onField("vcsIdentifier")} placeholder="owner/repository…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stack-execution-mode">Execution mode</Label>
            <Select id="stack-execution-mode" name="execution-mode" value={form.executionMode} onChange={onField("executionMode")} >
              <option value="remote">Remote</option>
              <option value="agent">Agent</option>
            </Select>
            {form.executionMode === "agent" && <p className="text-xs text-muted-foreground">Agent mode requires an agent-pool relationship.</p>}
          </div>
          {form.executionMode === "agent" && agentPoolsAvailable && (
            <div className="space-y-1.5">
              <Label htmlFor="stack-agent-pool">Agent pool</Label>
              <Select id="stack-agent-pool" name="agent-pool" value={form.agentPoolId} onChange={onField("agentPoolId")} >
                <option value="">Select an agent pool</option>
                {agentPools.map((pool): React.JSX.Element => <option key={pool.id} value={pool.id}>{pool.attributes.name ?? pool.id}</option>)}
              </Select>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="stack-provider">VCS service provider</Label>
              <Select id="stack-provider" name="service-provider" value={form.vcsServiceProvider} onChange={onField("vcsServiceProvider")} >
                <option value="github">GitHub</option>
                <option value="github_enterprise">GitHub Enterprise</option>
                <option value="gitlab_hosted">GitLab</option>
                <option value="gitlab_community_edition">GitLab Community Edition</option>
                <option value="gitlab_enterprise_edition">GitLab Enterprise Edition</option>
                <option value="ado_server">Azure DevOps Server</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stack-branch">Branch</Label>
              <Input id="stack-branch" name="branch" autoComplete="off" value={form.vcsBranch} onChange={onField("vcsBranch")} placeholder="main (optional)…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stack-working-dir">Working directory</Label>
              <Input id="stack-working-dir" name="working-directory" autoComplete="off" value={form.workingDirectory} onChange={onField("workingDirectory")} placeholder="terraform (optional)…" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stack-repository-url">Repository HTTP URL</Label>
            <Input id="stack-repository-url" name="repository-http-url" autoComplete="url" value={form.vcsRepositoryHttpUrl} onChange={onField("vcsRepositoryHttpUrl")} placeholder="https://git.example.com/org/repo.git" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="stack-display-identifier">Display identifier</Label>
              <Input id="stack-display-identifier" name="display-identifier" autoComplete="off" value={form.vcsDisplayIdentifier} onChange={onField("vcsDisplayIdentifier")} placeholder="Optional label…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stack-tags-regex">Tags regex</Label>
              <Input id="stack-tags-regex" name="tags-regex" autoComplete="off" value={form.vcsTagsRegex} onChange={onField("vcsTagsRegex")} placeholder="Optional tag pattern…" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stack-sparse-checkout">Sparse checkout pattern</Label>
            <Input id="stack-sparse-checkout" name="sparse-checkout-pattern" autoComplete="off" value={form.vcsSparseCheckoutPattern} onChange={onField("vcsSparseCheckoutPattern")} placeholder="Optional path pattern…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stack-description">Description</Label>
            <Input id="stack-description" name="description" autoComplete="off" value={form.description} onChange={onField("description")} placeholder="Optional…" />
          </div>
          <label htmlFor="stack-speculative" className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              id="stack-speculative"
              checked={form.speculative}
              onCheckedChange={(checked: boolean | "indeterminate"): void => { updateForm((prev): StackForm => ({ ...prev, speculative: checked === true })); }}
            />
            Speculative planner enabled
          </label>
          <label htmlFor="stack-trigger-disabled" className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox id="stack-trigger-disabled" checked={form.triggerDisabled} onCheckedChange={(checked: boolean | "indeterminate"): void => { updateForm((prev): StackForm => ({ ...prev, triggerDisabled: checked === true })); }} />
            Disable VCS-triggered runs
          </label>
          <label htmlFor="stack-debugging" className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox id="stack-debugging" checked={form.debuggingMode} onCheckedChange={(checked: boolean | "indeterminate"): void => { updateForm((prev): StackForm => ({ ...prev, debuggingMode: checked === true })); }} />
            Enable debugging mode
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={onSubmit} disabled={saving}>
            {saving ? "Saving…" : editingStack === null ? "Create stack" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StackSettings(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const orgPath = `/app/${encodeURIComponent(orgName)}`;
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [latestConfigurations, setLatestConfigurations] = useState<Record<string, LatestConfiguration>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [agentPools, setAgentPools] = useState<AgentPool[]>([]);
  const [agentPoolsAvailable, setAgentPoolsAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  const latestLoadId = useRef(0);
  activeOrganizationName.current = orgName;
  const orgPermissions = useOrganizationPermissions(orgName === "" ? undefined : orgName);
  const canManage = orgName !== "" && orgPermissions.loaded && orgPermissions.has("can-manage-projects");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingStack, setEditingStack] = useState<Stack | null>(null);
  const [form, setForm] = useState<StackForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  const [stackToDelete, setStackToDelete] = useState<Stack | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [fetchingStackId, setFetchingStackId] = useState<string | null>(null);
  const busyStackIdsRef = useRef(new Set<string>());
  const [busyStackIds, setBusyStackIds] = useState<ReadonlySet<string>>(new Set());

  useEffect((): void => {
    setStacks([]);
    setLatestConfigurations({});
    setProjects([]);
    setAgentPools([]);
    setAgentPoolsAvailable(false);
    setStackToDelete(null);
    permissionGateFired.current = false;
  }, [orgName]);

  // Central permission gate (14.6): once org permissions load, surface a clear
  // error when the operator lacks access. When access is granted, load the data
  // exactly once (the initial call early-returns while permissions are loading).
  const permissionGateFired = useRef(false);
  useEffect((): void => {
    if (!orgPermissions.loaded) return;
    if (orgPermissions.has("can-manage-projects")) {
      setError("");
      if (!permissionGateFired.current) {
        permissionGateFired.current = true;
        void loadStacks();
      }
    } else {
      setError(orgPermissions.error ?? "You do not have permission to manage stacks for this organization.");
    }
  }, [orgPermissions.loaded, orgPermissions.has]);

  const loadStacks = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    if (activeOrganizationName.current !== requestedOrganizationName) return;
    const loadId = ++latestLoadId.current;
    const isCurrentLoad = (): boolean =>
      activeOrganizationName.current === requestedOrganizationName && latestLoadId.current === loadId;
    setLoading(true);
    setError("");
    if (!canManage) {
      setLoading(false);
      return;
    }
    try {
      // SAFETY: both endpoints return the JSON:API list envelope per contract.
      const [stacksResponse, projectsResponse] = await Promise.all([
        fetchApi(`/organizations/${encodeURIComponent(requestedOrganizationName)}/stacks`) as Promise<{ data: Stack[] }>,
        fetchApi(`/organizations/${encodeURIComponent(requestedOrganizationName)}/projects`) as Promise<{ data: Project[] }>,
      ]);
      if (!isCurrentLoad()) return;
      const configurations: Record<string, LatestConfiguration> = Object.fromEntries(
        stacksResponse.data.map((stack): [string, LatestConfiguration] => [stack.id, "loading"]),
      );
      setStacks(stacksResponse.data);
      setProjects(projectsResponse.data);
      setAgentPools([]);
      setAgentPoolsAvailable(false);
      setLatestConfigurations(configurations);
      setLoading(false);
      void fetchApi(`/organizations/${encodeURIComponent(requestedOrganizationName)}/agent-pools?page[size]=100`)
        .then((response): void => {
          if (!isCurrentLoad()) return;
          const pools = (response as { data?: AgentPool[] }).data;
          setAgentPools(pools ?? []);
          setAgentPoolsAvailable(pools !== undefined);
        })
        .catch((): void => {
          if (isCurrentLoad()) {
            setAgentPools([]);
            setAgentPoolsAvailable(false);
          }
        });
      const loadConfiguration = async (stack: Stack): Promise<void> => {
        try {
          const response = await fetchApi(`/stacks/${encodeURIComponent(stack.id)}/stack-configurations?page[size]=1`) as { data: StackConfiguration[] };
          configurations[stack.id] = response.data[0] ?? null;
        } catch {
          configurations[stack.id] = "error";
        }
        if (isCurrentLoad()) setLatestConfigurations({ ...configurations });
      };
      for (let offset = 0; offset < stacksResponse.data.length; offset += 4) {
        await Promise.all(stacksResponse.data.slice(offset, offset + 4).map(loadConfiguration));
      }
    } catch (reason) {
      if (isCurrentLoad()) {
        setError(reason instanceof Error ? reason.message : "Failed to load stacks.");
      }
    } finally {
      if (isCurrentLoad()) setLoading(false);
    }
  };

  const openCreate = (): void => {
    setEditingStack(null);
    const singleProject = projects.length === 1 ? projects[0] : undefined;
    setForm(singleProject === undefined ? emptyForm : { ...emptyForm, projectId: singleProject.id });
    setDialogOpen(true);
  };

  const openEdit = (stack: Stack): void => {
    setEditingStack(stack);
    setForm(stackFormFromStack(stack));
    setDialogOpen(true);
  };

  const set = (key: keyof StackForm): ((e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void) =>
    (e): void => { setForm((prev): StackForm => ({ ...prev, [key]: e.target.value })); };

  const submit = async (): Promise<void> => {
    setSaving(true);
    setError("");
    const validationError = validateStackForm(form, editingStack !== null);
    if (validationError !== null) {
      setError(validationError);
      setSaving(false);
      return;
    }
    const attributes = stackSubmitAttributes(form, editingStack);
    try {
      if (editingStack === null) {
        await fetchApi("/stacks", {
          method: "POST",
          body: JSON.stringify({
            data: {
              attributes,
              relationships: { project: { data: { id: form.projectId, type: "projects" } }, ...(form.agentPoolId === "" ? {} : { "agent-pool": { data: { id: form.agentPoolId, type: "agent-pools" } } }) },
            },
          }),
        });
      } else {
        await fetchApi(`/stacks/${editingStack.id}`, {
          method: "PATCH",
          body: JSON.stringify({ data: { attributes, relationships: { "agent-pool": { data: form.agentPoolId === "" ? null : { id: form.agentPoolId, type: "agent-pools" } } } } }),
        });
      }
      setDialogOpen(false);
      await loadStacks();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to save stack.");
    } finally {
      setSaving(false);
    }
  };

  const fetchLatest = async (stack: Stack): Promise<void> => {
    setFetchingStackId(stack.id);
    setError("");
    try {
      await fetchApi(`/stacks/${stack.id}/fetch-latest-from-vcs`, { method: "POST" });
      await loadStacks();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to fetch latest from VCS.");
    } finally {
      setFetchingStackId(null);
    }
  };

  const prepareConfiguration = async (stack: Stack): Promise<void> => {
    if (!canManage || busyStackIdsRef.current.has(stack.id)) return;
    busyStackIdsRef.current.add(stack.id);
    setBusyStackIds(new Set(busyStackIdsRef.current));
    setError("");
    try {
      const response = await fetchApi(`/stacks/${stack.id}/stack-configurations?source=manual`, { method: "POST", body: JSON.stringify({ data: { attributes: { speculative: stack.attributes["speculative-enabled"] === true } } }) }) as { data: StackConfiguration };
      setLatestConfigurations((previous): Record<string, LatestConfiguration> => ({ ...previous, [stack.id]: response.data }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to prepare stack configuration.");
    } finally {
      busyStackIdsRef.current.delete(stack.id);
      setBusyStackIds(new Set(busyStackIdsRef.current));
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (stackToDelete === null) return;
    setDeleting(true);
    setError("");
    try {
      await fetchApi(`/stacks/${stackToDelete.id}`, { method: "DELETE" });
      setStacks((prev): Stack[] => prev.filter((s): boolean => s.id !== stackToDelete.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to delete stack.");
    } finally {
      setDeleting(false);
      setStackToDelete(null);
    }
  };

  return (
    <PageShell>
      <PageHeader
        breadcrumbs={[
          { label: orgName, to: `${orgPath}/workspaces` },
          { label: "Settings", to: `${orgPath}/settings` },
          { label: "Stacks" },
        ]}
        title="Stacks"
        description="A stack groups workspaces that are deployed together and depend on each other, so one change can roll through them in order. Most setups do not need one."
        action={canManage ? (
          <Button onClick={openCreate}>
            <span className="mr-1.5 text-base leading-none">+</span> New stack
          </Button>
        ) : undefined}
      />

      {error !== "" && !loading && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>VCS repo</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Working directory</TableHead>
                <TableHead>Execution</TableHead>
                <TableHead>Speculative</TableHead>
                <TableHead>Latest configuration</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-32 text-center">
                    <div className="flex justify-center py-12">
                      <Spinner />
                    </div>
                  </TableCell>
                </TableRow>
              ) : stacks.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                    <EmptyState compact title={error === "" ? "No stacks yet" : "Stacks unavailable"} description={error === "" ? "Group related components and deployments in a stack." : error} docsHref="/app/docs/stacks" />
                  </TableCell>
                </TableRow>
              ) : stacks.map((stack): React.JSX.Element => {
                const latest = latestConfigurations[stack.id];
                return (
                <TableRow key={stack.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <Layers className="h-4 w-4 text-muted-foreground" />
                      {stack.attributes.name}
                    </div>
                    {isString(stack.attributes.description) && stack.attributes.description !== "" && (
                      <div className="text-xs text-muted-foreground">{stack.attributes.description}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {vcsRepo(stack)?.identifier ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {vcsRepo(stack)?.branch ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {stack.attributes["working-directory"] ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {stack.attributes["execution-mode"] === "agent" ? "Agent" : "Remote"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                        {stack.attributes["speculative-enabled"] === true ? "Enabled" : "Disabled"}
                        <StackTriggerFlags stack={stack} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <StackLatestCell latest={latest} canManage={canManage} busy={busyStackIds.has(stack.id)} onPrepare={(): void => { void prepareConfiguration(stack); }} />
                  </TableCell>
                  <TableCell>
                    {canManage && (
                      <div className="flex items-center justify-end gap-1">
                        {stackHasVcsRemote(stack) && (
                          <Button variant="ghost" size="icon" onClick={(): void => { void fetchLatest(stack); }} aria-label={`Fetch latest for ${stack.attributes.name}`} disabled={fetchingStackId === stack.id}>
                            <RefreshCw className={`h-4 w-4 ${fetchingStackId === stack.id ? "animate-spin" : ""}`} />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" onClick={(): void => { openEdit(stack); }} aria-label={`Edit ${stack.attributes.name}`}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={(): void => { setStackToDelete(stack); }} aria-label={`Delete ${stack.attributes.name}`}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <StackFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editingStack={editingStack}
        form={form}
        projects={projects}
        agentPools={agentPools}
        agentPoolsAvailable={agentPoolsAvailable}
        saving={saving}
        onField={set}
        updateForm={setForm}
        onSubmit={submit}
        onCancel={(): void => { setDialogOpen(false); }}
      />

      <ConfirmDialog
        open={stackToDelete !== null}
        onOpenChange={(open): void => { if (!open) setStackToDelete(null); }}
        title="Delete stack"
        description="Deleting a stack removes it and its deployments. This cannot be undone."
        confirmText="Delete"
        confirmVariant="destructive"
        requireText={stackToDelete?.attributes.name}
        loading={deleting}
        onConfirm={confirmDelete}
      />
    </PageShell>
  );
}
