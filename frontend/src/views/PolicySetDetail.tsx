import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Spinner } from "../components/ui/spinner";
import { Badge } from "../components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectItem } from "../components/ui/select";
import { toast } from "../components/ui/toast";
import { FileText, GitBranch, Plus, Tags, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

const ENFORCEMENTS = [
  { value: "hard-mandatory", label: "Hard mandatory" },
  { value: "soft-mandatory", label: "Soft mandatory" },
  { value: "advisory", label: "Advisory" },
] as const;

type PolicySetRelationships = {
  policies?: { data?: { id: string; type: string }[] };
  workspaces?: { data?: { id: string; type: string }[] };
  projects?: { data?: { id: string; type: string }[] };
  "workspace-exclusions"?: { data?: { id: string; type: string }[] };
};

type TagSelector = {
  "tag-key": string;
  "tag-value": string | null;
  "is-exclude": boolean;
};

type PolicySet = {
  id: string;
  attributes: {
    name: string;
    description?: string | null;
    kind?: string;
    global?: boolean;
    overridable?: boolean;
    "policy-update-patterns"?: string[];
    "policies-path"?: string | null;
    "vcs-repo"?: { identifier?: string; branch?: string | null } | null;
    "tag-selectors"?: TagSelector[];
  };
  relationships?: PolicySetRelationships;
};

type Policy = {
  id: string;
  attributes: {
    name: string;
    description?: string | null;
    "enforcement-level"?: string;
    query?: string | null;
  };
};

type Param = {
  id: string;
  attributes: {
    key: string;
    value?: string | null;
    sensitive?: boolean;
    hcl?: boolean;
  };
};

type Workspace = {
  id: string;
  attributes: { name: string };
  relationships?: { project?: { data: { id: string } | null } };
};

type Project = { id: string; attributes: { name: string } };

type Tab = "overview" | "tags" | "policies" | "attachments" | "parameters" | "vcs";

export function PolicySetDetail({ section = "overview" }: Readonly<{ section?: Tab }>): React.JSX.Element {
  const { orgName: rawOrgName, policySetId } = useParams<{ orgName: string; policySetId: string }>();
  const orgName = rawOrgName ?? "";
  const orgPath = `/app/${encodeURIComponent(orgName)}`;
  const setId = policySetId ?? "";
  const [activeTab, setActiveTab] = useState<Tab>(section);
  const requestedOrg = useRef(orgName);
  const requestedSet = useRef(setId);
  requestedOrg.current = orgName;
  requestedSet.current = setId;

  const [policySet, setPolicySet] = useState<PolicySet | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [params, setParams] = useState<Param[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [canManage, setCanManage] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);

  const [overviewDirty, setOverviewDirty] = useState(false);
  const [overName, setOverName] = useState("");
  const [overDescription, setOverDescription] = useState("");
  const [overGlobal, setOverGlobal] = useState(false);
  const [overOverridable, setOverOverridable] = useState(true);
  const [savingOverview, setSavingOverview] = useState(false);

  const [policyDialogOpen, setPolicyDialogOpen] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<Policy | null>(null);
  const [policyFormError, setPolicyFormError] = useState("");
  const [policyName, setPolicyName] = useState("");
  const [policyDescription, setPolicyDescription] = useState("");
  const [policyEnforcement, setPolicyEnforcement] = useState("soft-mandatory");
  const [policyQuery, setPolicyQuery] = useState("");
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyToDelete, setPolicyToDelete] = useState<Policy | null>(null);

  const [attachWorkspaceOpen, setAttachWorkspaceOpen] = useState(false);
  const [attachProjectOpen, setAttachProjectOpen] = useState(false);
  const [selectedWorkspaces, setSelectedWorkspaces] = useState<Set<string>>(new Set());
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [savingAttach, setSavingAttach] = useState(false);
  const [attachKind, setAttachKind] = useState<"workspaces" | "projects">("workspaces");

  const [selectorKey, setSelectorKey] = useState("");
  const [selectorValue, setSelectorValue] = useState("");
  const [selectorExclude, setSelectorExclude] = useState(false);
  const [selectorError, setSelectorError] = useState("");
  const [savingSelector, setSavingSelector] = useState(false);

  const [paramDialogOpen, setParamDialogOpen] = useState(false);
  const [editingParam, setEditingParam] = useState<Param | null>(null);
  const [paramFormError, setParamFormError] = useState("");
  const [paramKey, setParamKey] = useState("");
  const [paramValue, setParamValue] = useState("");
  const [paramHcl, setParamHcl] = useState(false);
  const [paramSensitive, setParamSensitive] = useState(false);
  const [savingParam, setSavingParam] = useState(false);
  const [paramToDelete, setParamToDelete] = useState<Param | null>(null);

  const reload = (): void => { setLoadNonce((n): number => n + 1); };

  useEffect((): () => void => {
    const controller = new AbortController();
    const requestedO = orgName;
    const requestedS = setId;
    setPolicySet(null);
    setPolicies([]);
    setParams([]);
    setLoading(true);
    setError("");
    setCanManage(false);
    const load = async (): Promise<void> => {
      try {
        const orgResponse = await fetchApi(`/organizations/${encodeURIComponent(requestedO)}`, { signal: controller.signal });
        const setResponse = await fetchApi(`/api/v2/policy-sets/${encodeURIComponent(requestedS)}`, { signal: controller.signal });
        if (controller.signal.aborted || requestedOrg.current !== requestedO || requestedSet.current !== requestedS) return;
        const permissions = (orgResponse as {
          data?: { attributes?: { permissions?: { "can-manage-policies"?: boolean } } };
        }).data?.attributes?.permissions;
        setCanManage(permissions?.["can-manage-policies"] === true);
        const data = (setResponse as { data: PolicySet }).data;
        setPolicySet(data);
        setOverName(data.attributes.name);
        setOverDescription(data.attributes.description ?? "");
        setOverGlobal(data.attributes.global === true);
        setOverOverridable(data.attributes.overridable !== false);
      } catch (err: unknown) {
        if (!controller.signal.aborted && requestedOrg.current === requestedO && requestedSet.current === requestedS) {
          setError(err instanceof Error ? err.message : "Failed to load policy set");
        }
      } finally {
        if (!controller.signal.aborted && requestedOrg.current === requestedO && requestedSet.current === requestedS) {
          setLoading(false);
        }
      }
    };
    void load();
    return (): void => { controller.abort(); };
  }, [orgName, setId, loadNonce]);

  useEffect((): (() => void) | undefined => {
    if (orgName === "") return undefined;
    const controller = new AbortController();
    const o = orgName;
    const s = setId;
    void Promise.allSettled([
      fetchApi(`/api/v2/policy-sets/${encodeURIComponent(s)}/policies`, { signal: controller.signal }),
      fetchApi(`/api/v2/policy-sets/${encodeURIComponent(s)}/parameters`, { signal: controller.signal }),
    ]).then(([policyResult, paramResult]): void => {
      if (controller.signal.aborted || requestedOrg.current !== o || requestedSet.current !== s) return;
      if (policyResult.status === "fulfilled") setPolicies((policyResult.value as { data?: Policy[] }).data ?? []);
      if (paramResult.status === "fulfilled") setParams((paramResult.value as { data?: Param[] }).data ?? []);
    });
    return (): void => { controller.abort(); };
  }, [orgName, setId, loadNonce]);

  useEffect((): (() => void) | undefined => {
    if (orgName === "") return undefined;
    const controller = new AbortController();
    const o = orgName;
    void Promise.allSettled([
      fetchApi(`/organizations/${encodeURIComponent(o)}/workspaces?page%5Bsize%5D=1000`, { signal: controller.signal }),
      fetchApi(`/organizations/${encodeURIComponent(o)}/projects?page%5Bsize%5D=1000`, { signal: controller.signal }),
    ]).then(([wsResult, projResult]): void => {
      if (controller.signal.aborted || requestedOrg.current !== o) return;
      if (wsResult.status === "fulfilled") setWorkspaces((wsResult.value as { data?: Workspace[] }).data ?? []);
      if (projResult.status === "fulfilled") setProjects((projResult.value as { data?: Project[] }).data ?? []);
    });
    return (): void => { controller.abort(); };
  }, [orgName, setId, loadNonce]);

  if (loading) {
    return (
      <div role="status" aria-label="Loading policy set" className="flex flex-col gap-5">
        <div className="h-3 w-40 animate-pulse rounded bg-muted" />
        <div className="h-10 w-80 animate-pulse rounded bg-muted" />
        <div className="h-24 animate-pulse rounded-md border bg-muted/50" />
        <div className="h-64 animate-pulse rounded-md border bg-muted/50" />
      </div>
    );
  }

  if (policySet === null) {
    return (
      <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-5 text-sm text-destructive">
        <p className="font-medium">{error !== "" ? error : "Policy set not found"}</p>
        <Button className="mt-3" variant="outline" onClick={reload}>Try again</Button>
      </div>
    );
  }

  const attrs = policySet.attributes;
  const relationship = policySet.relationships ?? {};
  const attachedWorkspaceIds = (relationship.workspaces?.data ?? []).map((r): string => r.id);
  const attachedProjectIds = (relationship.projects?.data ?? []).map((r): string => r.id);
  const attachedExclusionIds = (relationship["workspace-exclusions"]?.data ?? []).map((r): string => r.id);
  const isVcsBacked = attrs["vcs-repo"] !== null && attrs["vcs-repo"] !== undefined;
  const isGlobal = attrs.global === true;
  const vcsRepoBranch = isVcsBacked ? attrs["vcs-repo"]?.branch : undefined;
  const updatePatternsText = (attrs["policy-update-patterns"] ?? []).join(", ");

  async function saveRelationTargets(): Promise<void> {
    if (!canManage || policySet === null) return;
    setSavingAttach(true);
    // Global policy sets edit workspace EXCLUSIONS, not attachments.
    const relationshipKind = attachKind === "workspaces" && isGlobal ? "workspace-exclusions" : attachKind;
    const endpoint = `/api/v2/policy-sets/${encodeURIComponent(setId)}/relationships/${relationshipKind}`;
    try {
      if (attachKind === "workspaces") {
        const current = new Set(isGlobal ? attachedExclusionIds : attachedWorkspaceIds);
        const toAdd = [...selectedWorkspaces].filter((id): boolean => !current.has(id));
        const toRemove = [...current].filter((id): boolean => !selectedWorkspaces.has(id));
        if (toAdd.length > 0) await fetchApi(endpoint, { method: "POST", body: JSON.stringify({ data: toAdd.map((id) => ({ id, type: "workspaces" })) }) });
        if (toRemove.length > 0) await fetchApi(endpoint, { method: "DELETE", body: JSON.stringify({ data: toRemove.map((id) => ({ id, type: "workspaces" })) }) });
      } else {
        const current = new Set(attachedProjectIds);
        const toAdd = [...selectedProjects].filter((id): boolean => !current.has(id));
        const toRemove = [...current].filter((id): boolean => !selectedProjects.has(id));
        if (toAdd.length > 0) await fetchApi(endpoint, { method: "POST", body: JSON.stringify({ data: toAdd.map((id) => ({ id, type: "projects" })) }) });
        if (toRemove.length > 0) await fetchApi(endpoint, { method: "DELETE", body: JSON.stringify({ data: toRemove.map((id) => ({ id, type: "projects" })) }) });
      }
      if (requestedSet.current !== setId) return;
      setAttachWorkspaceOpen(false);
      setAttachProjectOpen(false);
      toast.add({ title: `Policy set ${attachKind} updated`, type: "success" });
      reload();
    } catch (err: unknown) {
      toast.add({ title: err instanceof Error ? err.message : "Failed to update targets", type: "error" });
    } finally {
      setSavingAttach(false);
    }
  }

  const tagSelectors = policySet.attributes["tag-selectors"] ?? [];

  const addTagSelector = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (!canManage) return;
    const key = selectorKey.trim().toLowerCase();
    if (key === "") {
      setSelectorError("Tag key is required.");
      return;
    }
    const duplicate = tagSelectors.some((selector): boolean =>
      selector["tag-key"].toLowerCase() === key
      && (selector["tag-value"] ?? "") === (selectorValue.trim() === "" ? null : selectorValue.trim())
      && selector["is-exclude"] === selectorExclude);
    if (duplicate) {
      setSelectorError("That tag selector already exists.");
      return;
    }
    setSavingSelector(true);
    setSelectorError("");
    try {
      await fetchApi(`/api/v2/policy-sets/${encodeURIComponent(setId)}/tag-selectors`, {
        method: "POST",
        body: JSON.stringify({
          data: [{
            "tag-key": key,
            "tag-value": selectorValue.trim() === "" ? null : selectorValue.trim(),
            "is-exclude": selectorExclude,
          }],
        }),
      });
      setSelectorKey("");
      setSelectorValue("");
      setSelectorExclude(false);
      reload();
    } catch (err: unknown) {
      setSelectorError(err instanceof Error ? err.message : "Failed to add tag selector.");
    } finally {
      setSavingSelector(false);
    }
  };

  const removeTagSelector = async (selector: TagSelector): Promise<void> => {
    if (!canManage) return;
    setSavingSelector(true);
    setSelectorError("");
    try {
      await fetchApi(`/api/v2/policy-sets/${encodeURIComponent(setId)}/tag-selectors`, {
        method: "DELETE",
        body: JSON.stringify({
          data: [{
            "tag-key": selector["tag-key"],
            "tag-value": selector["tag-value"],
            "is-exclude": selector["is-exclude"],
          }],
        }),
      });
      reload();
    } catch (err: unknown) {
      setSelectorError(err instanceof Error ? err.message : "Failed to remove tag selector.");
    } finally {
      setSavingSelector(false);
    }
  };

  const tabs: readonly { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "tags", label: "Tag selectors" },
    { id: "policies", label: "Policies" },
    { id: "attachments", label: "Attachments" },
    { id: "parameters", label: "Parameters" },
    { id: "vcs", label: "VCS" },
  ];

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Link to={`${orgPath}/settings/policy-sets`} className="hover:underline">Policy sets</Link>
        <span aria-hidden="true">/</span>
        <span className="text-foreground">{attrs.name}</span>
      </nav>

      <HeaderLeft name={attrs.name} kind={attrs.kind ?? "sentinel"} isGlobal={isGlobal} isVcsBacked={isVcsBacked} />
      <p className="text-sm text-muted-foreground">{attrs.description ?? "No description provided."}</p>

      <div className="mb-2 flex flex-wrap gap-x-6 gap-y-2 border-b">
        {tabs.map((tab): React.JSX.Element => (
          <button
            type="button"
            key={tab.id}
            onClick={(): void => { setActiveTab(tab.id); }}
            aria-current={activeTab === tab.id ? "page" : undefined}
            className={cn(
              "rounded-sm border-b-2 pb-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              activeTab === tab.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error !== "" && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-destructive/15 p-4 text-sm font-medium text-destructive">
          <span>{error}</span>
          <Button type="button" size="sm" variant="outline" onClick={reload}>Try again</Button>
        </div>
      )}

      {activeTab === "overview" && (
        <Card>
          <CardHeader>
            <CardTitle>General</CardTitle>
            <CardDescription>Configure the policy set name, description, and default behavior.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="ps-name" className="text-sm font-medium">Name</label>
              <Input id="ps-name" name="policy-set-name" autoComplete="off" spellCheck={false} value={overName} disabled={!canManage}
                onInput={(e): void => { setOverName(e.currentTarget.value); setOverviewDirty(true); }} />
            </div>
            <div className="space-y-2">
              <label htmlFor="ps-desc" className="text-sm font-medium">Description</label>
              <textarea id="ps-desc" name="policy-set-description" autoComplete="off" spellCheck={false} rows={3} disabled={!canManage} value={overDescription}
                onInput={(e): void => { setOverDescription(e.currentTarget.value); setOverviewDirty(true); }}
                className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50" />
            </div>
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={overGlobal} disabled={!canManage} onCheckedChange={(c: boolean | "indeterminate"): void => { setOverGlobal(c === true); setOverviewDirty(true); }} />
                Apply to all workspaces (global policy set)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={overOverridable} disabled={!canManage} onCheckedChange={(c: boolean | "indeterminate"): void => { setOverOverridable(c === true); setOverviewDirty(true); }} />
                Allow policy overrides
              </label>
            </div>
            {canManage && (
              <div className="flex justify-end gap-2">
                <Button variant="outline" disabled={!overviewDirty || savingOverview} onClick={reload}>Cancel</Button>
                <Button disabled={!overviewDirty || savingOverview || overName.trim() === ""}
                  onClick={(): void => { void updateOverview(); }}>
                  {savingOverview && <Spinner data-icon="inline-start" className="size-4" />}
                  {savingOverview ? "Saving changes…" : "Save changes"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === "tags" && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Tag selectors</CardTitle>
              <CardDescription>
                Apply this policy set to workspaces and projects that match these tags. Include rules match all
                specified tags; exclude rules remove matching resources regardless of include rules.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tag key</TableHead>
                    <TableHead>Tag value</TableHead>
                    <TableHead>Behavior</TableHead>
                    {canManage && <TableHead className="w-16 text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tagSelectors.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={canManage ? 4 : 3} className="h-24 text-center text-muted-foreground">
                        <div className="flex flex-col items-center gap-2">
                          <Tags className="size-8 text-muted-foreground/60" />
                          {isVcsBacked
                            ? "Tag selectors are managed from the connected version control repository."
                            : "No tag selectors yet. Add one to target specific workspaces."}
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : tagSelectors.map((selector, index): React.JSX.Element => (
                    <TableRow key={`${selector["tag-key"]}-${selector["tag-value"] ?? "*"}-${selector["is-exclude"]}-${index}`}>
                      <TableCell className="font-medium">{selector["tag-key"]}</TableCell>
                      <TableCell className="text-muted-foreground">{selector["tag-value"] ?? <em>any</em>}</TableCell>
                      <TableCell>
                        <Badge variant={selector["is-exclude"] ? "destructive" : "secondary"}>
                          {selector["is-exclude"] ? "Exclude" : "Include"}
                        </Badge>
                      </TableCell>
                      {canManage && (
                        <TableCell className="text-right">
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              disabled={savingSelector}
                              onClick={(): void => { void removeTagSelector(selector); }}
                            >
                              <Trash2 className="size-3.5 mr-1" />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {canManage && (
            <Card>
              <CardHeader>
                <CardTitle>Add tag selector</CardTitle>
                <CardDescription>Target resources by their workspace or project tags.</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={(e): void => { void addTagSelector(e); }} className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="space-y-2">
                      <label htmlFor="selector-key" className="text-sm font-medium">
                        Tag key <span className="text-destructive">*</span>
                      </label>
                      <Input
                        id="selector-key"
                        name="tag-selector-key"
                        autoComplete="off"
                        spellCheck={false}
                        required
                        value={selectorKey}
                        onInput={(e): void => { setSelectorKey(e.currentTarget.value); }}
                        placeholder="environment"
                      />
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="selector-value" className="text-sm font-medium">
                        Tag value
                      </label>
                      <Input
                        id="selector-value"
                        name="tag-selector-value"
                        autoComplete="off"
                        spellCheck={false}
                        value={selectorValue}
                        onInput={(e): void => { setSelectorValue(e.currentTarget.value); }}
                        placeholder="production"
                      />
                      <p className="text-xs text-muted-foreground">Leave empty to match any value for the key.</p>
                    </div>
                    <div className="space-y-2">
                      <span className="text-sm font-medium">Behavior</span>
                      <label className="flex h-9 items-center gap-2 text-sm">
                        <Checkbox
                          checked={selectorExclude}
                          onCheckedChange={(c: boolean | "indeterminate"): void => { setSelectorExclude(c === true); }}
                        />
                        Exclude matching resources
                      </label>
                    </div>
                  </div>
                  {selectorError !== "" && <div role="alert" className="text-sm text-destructive">{selectorError}</div>}
                  <div className="flex justify-end">
                    <Button type="submit" disabled={savingSelector || selectorKey.trim() === ""}>
                      {savingSelector && <Spinner data-icon="inline-start" className="size-4" />}
                      {!savingSelector && <Plus className="size-4 mr-1.5" />}
                      {savingSelector ? "Adding selector…" : "Add selector"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {activeTab === "policies" && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Policies</CardTitle>
              <CardDescription>
                {isVcsBacked
                  ? "Policies in this set are managed from the connected version control repository."
                  : "Sentinel policies checked against every workspace plan and apply."}
              </CardDescription>
            </div>
            {canManage && !isVcsBacked && (
              <Button onClick={openCreatePolicy}><Plus className="mr-1.5 size-4" /> Add policy</Button>
            )}
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Enforcement</TableHead>
                  {canManage && !isVcsBacked && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {policies.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                      <div className="flex flex-col items-center gap-2">
                        <FileText className="size-8 text-muted-foreground/60" />
                        No policies yet.
                      </div>
                    </TableCell>
                  </TableRow>
                ) : policies.map((policy): React.JSX.Element => (
                  <TableRow key={policy.id}>
                    <TableCell className="font-medium">{policy.attributes.name}</TableCell>
                    <TableCell className="max-w-[320px] text-sm text-muted-foreground">{policy.attributes.description ?? ""}</TableCell>
                    <TableCell>
                      <Badge variant={policy.attributes["enforcement-level"] === "hard-mandatory" ? "destructive" : "secondary"}>
                        {(policy.attributes["enforcement-level"] ?? "soft-mandatory").replace("-", " ")}
                      </Badge>
                    </TableCell>
                    {canManage && !isVcsBacked && (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="outline" onClick={(): void => { openEditPolicy(policy); }}>Edit</Button>
                          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive"
                            onClick={(): void => { setPolicyToDelete(policy); }}>
                            <Trash2 className="size-3.5 mr-1" />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {activeTab === "attachments" && (
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Workspaces {isGlobal && "and exclusions"}</CardTitle>
                <CardDescription>
                  {isGlobal
                    ? "Exclude specific workspaces from this global policy set."
                    : "Apply this policy set to specific workspaces directly."}
                </CardDescription>
              </div>
              {canManage && (
                <Button variant="outline" onClick={openWorkspacePicker}>
                  {isGlobal ? "Edit exclusions" : "Manage workspaces"}
                </Button>
              )}
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>Workspace</TableHead><TableHead>Mode</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {isGlobal ? (attachedExclusionIds.length === 0 ? (
                    <TableRow><TableCell colSpan={2} className="h-16 text-center text-muted-foreground">This global policy set applies to every workspace.</TableCell></TableRow>
                  ) : attachedExclusionIds.map((id): React.JSX.Element => (
                    <TableRow key={id}>
                      <TableCell>{workspaces.find((w): boolean => w.id === id)?.attributes.name ?? id}</TableCell>
                      <TableCell><Badge variant="secondary">Excluded</Badge></TableCell>
                    </TableRow>
                  ))) : (attachedWorkspaceIds.length === 0 ? (
                    <TableRow><TableCell colSpan={2} className="h-16 text-center text-muted-foreground">No workspaces attached.</TableCell></TableRow>
                  ) : attachedWorkspaceIds.map((id): React.JSX.Element => (
                    <TableRow key={id}>
                      <TableCell>{workspaces.find((w): boolean => w.id === id)?.attributes.name ?? id}</TableCell>
                      <TableCell><Badge variant="secondary">Attached</Badge></TableCell>
                    </TableRow>
                  )))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Projects</CardTitle>
                <CardDescription>Apply this policy set to all workspaces in a project.</CardDescription>
              </div>
              {canManage && (
                <Button variant="outline" onClick={openProjectPicker}>Manage projects</Button>
              )}
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>Project</TableHead><TableHead>Mode</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {attachedProjectIds.length === 0 ? (
                    <TableRow><TableCell colSpan={2} className="h-16 text-center text-muted-foreground">No projects attached.</TableCell></TableRow>
                  ) : attachedProjectIds.map((id): React.JSX.Element => (
                    <TableRow key={id}>
                      <TableCell>{projects.find((p): boolean => p.id === id)?.attributes.name ?? id}</TableCell>
                      <TableCell><Badge variant="secondary">Attached</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === "parameters" && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Parameters</CardTitle>
              <CardDescription>Variables exposed to the Sentinel policies in this set at evaluation time.</CardDescription>
            </div>
            {canManage && (
              <Button variant="outline" onClick={openCreateParam}><Plus className="mr-1.5 size-4" /> Add parameter</Button>
            )}
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow><TableHead>Key</TableHead><TableHead>Value</TableHead><TableHead>Type</TableHead><TableHead className="text-right">Actions</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {params.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No parameters defined.</TableCell></TableRow>
                ) : params.map((p): React.JSX.Element => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-sm font-medium">{p.attributes.key}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{p.attributes.sensitive === true ? "Messages-redacted" : (p.attributes.value ?? "")}</TableCell>
                    <TableCell><Badge variant="outline">{p.attributes.hcl === true ? "HCL" : "Plain"}</Badge></TableCell>
                    <TableCell className="text-right">
                      {canManage && (
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="outline" onClick={(): void => { openEditParam(p); }}>Edit</Button>
                          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={(): void => { setParamToDelete(p); }}>
                            <Trash2 className="size-3.5 mr-1" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {activeTab === "vcs" && (
        <Card>
          <CardHeader>
            <CardTitle>Version control</CardTitle>
            <CardDescription>
              {isVcsBacked
                ? "This policy set is synced from a version control repository."
                : "This policy set is managed in the UI; policies live in Terrence."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {isVcsBacked ? (
              <>
                <div className="flex items-center gap-2"><GitBranch className="size-4 text-primary" /><code>{attrs["vcs-repo"]?.identifier}</code></div>
                {vcsRepoBranch != null && <p className="text-muted-foreground">Branch: <code>{vcsRepoBranch}</code></p>}
                {attrs["policies-path"] != null && <p className="text-muted-foreground">Policies path: <code>{attrs["policies-path"]}</code></p>}
                <p className="text-muted-foreground">Update patterns: <code className="break-all">{updatePatternsText === "" ? "All" : updatePatternsText}</code></p>
                <p className="text-xs text-muted-foreground">Policy source and versions are managed in the repository. Direct edits are not supported here.</p>
              </>
            ) : (
              <p className="text-muted-foreground">
                Policies are authored directly in Terrence. To manage this set from a version control
                repository, create it with a VCS connection from the{" "}
                <Link to={`${orgPath}/settings/vcs`} className="text-primary hover:underline">VCS providers</Link> page.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={policyDialogOpen} onOpenChange={(open: boolean): void => { if (!open && !savingPolicy) setPolicyDialogOpen(false); }}>
        <DialogContent className="sm:max-w-[720px]">
          <form onSubmit={submitPolicy} noValidate>
            <DialogHeader>
              <DialogTitle>{editingPolicy === null ? "Add policy" : "Edit policy"}</DialogTitle>
              <DialogDescription>Write a Sentinel policy and choose its enforcement level.</DialogDescription>
            </DialogHeader>
            {policyFormError !== "" && (
              <div role="alert" className="rounded bg-destructive/15 p-3 text-xs font-medium text-destructive">{policyFormError}</div>
            )}
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="policy-name">Name</label>
                <Input id="policy-name" name="name" value={policyName} onInput={(e): void => { setPolicyName(e.currentTarget.value); }} placeholder="runtime_version" required />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="policy-description">Description</label>
                <Input id="policy-description" name="description" value={policyDescription} onInput={(e): void => { setPolicyDescription(e.currentTarget.value); }} placeholder="Optional description" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="policy-enforcement">Enforcement level</label>
                <Select id="policy-enforcement" name="enforcement" value={policyEnforcement} onValueChange={setPolicyEnforcement}>
                  {ENFORCEMENTS.map((lvl): React.JSX.Element => <SelectItem key={lvl.value} value={lvl.value}>{lvl.label}</SelectItem>)}
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="policy-code">Policy code <span className="font-normal text-muted-foreground">(Sentinel)</span></label>
                <textarea
                  id="policy-code"
                  name="policy-code"
                  rows={14}
                  spellCheck={false}
                  value={policyQuery}
                  onInput={(e): void => { setPolicyQuery(e.currentTarget.value); }}
                  placeholder="main = rule { true }"
                  className="w-full resize-y rounded-md border border-input bg-code-background px-3 py-2 font-mono text-xs leading-5 text-code-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={savingPolicy} onClick={(): void => { setPolicyDialogOpen(false); }}>Cancel</Button>
              <Button type="submit" disabled={savingPolicy || policyName.trim() === ""}>
                {savingPolicy && <Spinner data-icon="inline-start" className="size-4" />}
                {savingPolicy ? "Saving policy…" : editingPolicy === null ? "Create policy" : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={paramDialogOpen} onOpenChange={(open: boolean): void => { if (!open && !savingParam) setParamDialogOpen(false); }}>
        <DialogContent className="sm:max-w-[520px]">
          <form onSubmit={submitParam} noValidate>
            <DialogHeader>
              <DialogTitle>{editingParam === null ? "Add parameter" : "Edit parameter"}</DialogTitle>
              <DialogDescription>Expose a variable to the Sentinel policies in this set.</DialogDescription>
            </DialogHeader>
            {paramFormError !== "" && (
              <div role="alert" className="rounded bg-destructive/15 p-3 text-xs font-medium text-destructive">{paramFormError}</div>
            )}
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="policy-param-key">Key</label>
                <Input id="policy-param-key" name="key" value={paramKey} onInput={(e): void => { setParamKey(e.currentTarget.value); }} placeholder="allowed_cidrs" required />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="policy-param-value">Value</label>
                <textarea id="policy-param-value" name="value" autoComplete="off" spellCheck={false} rows={3} value={paramValue} onInput={(e): void => { setParamValue(e.currentTarget.value); }}
                  className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring" />
              </div>
              <div className="flex flex-col gap-3">
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={paramHcl} onCheckedChange={(c: boolean | "indeterminate"): void => { setParamHcl(c === true); }} /> Parse value as HCL</label>
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={paramSensitive} onCheckedChange={(c: boolean | "indeterminate"): void => { setParamSensitive(c === true); }} /> Sensitive value</label>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={savingParam} onClick={(): void => { setParamDialogOpen(false); }}>Cancel</Button>
              <Button type="submit" disabled={savingParam || paramKey.trim() === ""}>
                {savingParam && <Spinner data-icon="inline-start" className="size-4" />}
                {savingParam ? "Saving parameter…" : editingParam === null ? "Add parameter" : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={attachWorkspaceOpen || attachProjectOpen} onOpenChange={(open: boolean): void => { if (!open && !savingAttach) { setAttachWorkspaceOpen(false); setAttachProjectOpen(false); } }}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{attachKind === "projects" ? "Manage projects" : isGlobal ? "Edit workspace exclusions" : "Manage workspaces"}</DialogTitle>
            <DialogDescription>
              {attachKind === "projects"
                ? "Select the projects this policy set applies to."
                : isGlobal
                  ? "Exclude workspaces from this global policy set."
                  : "Select the workspaces this policy set applies to directly."}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[420px] space-y-1 overflow-y-auto py-3">
            {(attachKind === "workspaces" ? workspaces : projects).length === 0 ? (
              <p className="text-sm text-muted-foreground">No {attachKind} in this organization.</p>
            ) : (attachKind === "workspaces" ? workspaces : projects).map((item): React.JSX.Element => {
              const id = item.id;
              const selected = attachKind === "workspaces" ? selectedWorkspaces.has(id) : selectedProjects.has(id);
              return (
                <label key={id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                  <Checkbox
                    checked={selected}
                    onCheckedChange={(checked: boolean | "indeterminate"): void => {
                      const apply = (prev: Set<string>): Set<string> => {
                        const next = new Set(prev);
                        if (checked === true) next.add(id); else next.delete(id);
                        return next;
                      };
                      if (attachKind === "workspaces") setSelectedWorkspaces(apply); else setSelectedProjects(apply);
                    }}
                  />
                  <span className="truncate">{item.attributes.name}</span>
                </label>
              );
            })}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={savingAttach} onClick={(): void => { setAttachWorkspaceOpen(false); setAttachProjectOpen(false); }}>Cancel</Button>
            <Button type="button" disabled={savingAttach} onClick={(): void => { void saveRelationTargets(); }}>
              {savingAttach && <Spinner data-icon="inline-start" className="size-4" />}
              {savingAttach ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={policyToDelete !== null}
        onOpenChange={(open: boolean): void => { if (!open) setPolicyToDelete(null); }}
        title="Delete policy"
        description={`Are you sure you want to delete policy "${policyToDelete?.attributes.name ?? ""}"?`}
        confirmText="Delete policy"
        confirmVariant="destructive"
        onConfirm={async (): Promise<void> => { if (policyToDelete !== null) await deletePolicy(policyToDelete); }}
      />

      <ConfirmDialog
        open={paramToDelete !== null}
        onOpenChange={(open: boolean): void => { if (!open) setParamToDelete(null); }}
        title="Delete parameter"
        description={`Are you sure you want to delete parameter "${paramToDelete?.attributes.key ?? ""}"?`}
        confirmText="Delete parameter"
        confirmVariant="destructive"
        onConfirm={async (): Promise<void> => { if (paramToDelete !== null) await deleteParam(paramToDelete); }}
      />
    </div>
  );

  async function updateOverview(): Promise<void> {
    if (!canManage || policySet === null) return;
    setSavingOverview(true);
    try {
      const response = await fetchApi(`/api/v2/policy-sets/${encodeURIComponent(setId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            type: "policy-sets",
            attributes: {
              name: overName.trim(),
              description: overDescription.trim() === "" ? null : overDescription.trim(),
              global: overGlobal,
              overridable: overOverridable,
            },
          },
        }),
      }) as { data: PolicySet };
      if (requestedSet.current !== setId) {
        return;
      }
      setPolicySet((prev): PolicySet | null => prev === null ? prev : ({ ...prev, attributes: { ...prev.attributes, ...response.data.attributes } }));
      setOverviewDirty(false);
      toast.add({ title: "Policy set updated", type: "success" });
    } catch (err: unknown) {
      toast.add({ title: err instanceof Error ? err.message : "Failed to update policy set", type: "error" });
    } finally {
      setSavingOverview(false);
    }
  }

  function openCreatePolicy(): void {
    setEditingPolicy(null);
    setPolicyName("");
    setPolicyDescription("");
    setPolicyEnforcement("soft-mandatory");
    setPolicyQuery("");
    setPolicyFormError("");
    setPolicyDialogOpen(true);
  }

  function openEditPolicy(pol: Policy): void {
    setEditingPolicy(pol);
    setPolicyName(pol.attributes.name);
    setPolicyDescription(pol.attributes.description ?? "");
    setPolicyEnforcement(pol.attributes["enforcement-level"] ?? "soft-mandatory");
    setPolicyQuery(pol.attributes.query ?? "");
    setPolicyFormError("");
    setPolicyDialogOpen(true);
  }

  async function submitPolicy(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    if (!canManage) return;
    setSavingPolicy(true);
    setPolicyFormError("");
    try {
      if (editingPolicy === null) {
        await fetchApi(`/api/v2/policy-sets/${encodeURIComponent(setId)}/policies`, {
          method: "POST",
          body: JSON.stringify({ data: { type: "policies", attributes: {
            name: policyName.trim(),
            description: policyDescription.trim() === "" ? null : policyDescription.trim(),
            "enforcement-level": policyEnforcement,
            policy: policyQuery,
          } } }),
        });
        toast.add({ title: "Policy created", type: "success" });
      } else {
        await fetchApi(`/api/v2/policies/${encodeURIComponent(editingPolicy.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ data: { type: "policies", attributes: {
            name: policyName.trim(),
            description: policyDescription.trim() === "" ? null : policyDescription.trim(),
            "enforcement-level": policyEnforcement,
            policy: policyQuery,
          } } }),
        });
        toast.add({ title: "Policy updated", type: "success" });
      }
      if (requestedSet.current !== setId) return;
      setPolicyDialogOpen(false);
      reload();
    } catch (err: unknown) {
      setPolicyFormError(err instanceof Error ? err.message : "Failed to save policy");
    } finally {
      setSavingPolicy(false);
    }
  }

  async function deletePolicy(pol: Policy): Promise<void> {
    if (!canManage) return;
    try {
      await fetchApi(`/api/v2/policies/${encodeURIComponent(pol.id)}`, { method: "DELETE" });
      if (requestedSet.current !== setId) return;
      setPolicies((prev): Policy[] => prev.filter((p): boolean => p.id !== pol.id));
      setPolicyToDelete(null);
      toast.add({ title: "Policy deleted", type: "success" });
    } catch (err: unknown) {
      toast.add({ title: err instanceof Error ? err.message : "Failed to delete policy", type: "error" });
      setPolicyToDelete(null);
    }
  }

  function openCreateParam(): void {
    setEditingParam(null);
    setParamKey("");
    setParamValue("");
    setParamHcl(false);
    setParamSensitive(false);
    setParamFormError("");
    setParamDialogOpen(true);
  }

  function openEditParam(p: Param): void {
    setEditingParam(p);
    setParamKey(p.attributes.key);
    setParamValue(p.attributes.value ?? "");
    setParamHcl(p.attributes.hcl === true);
    setParamSensitive(p.attributes.sensitive === true);
    setParamFormError("");
    setParamDialogOpen(true);
  }

  async function submitParam(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    if (!canManage) return;
    setSavingParam(true);
    setParamFormError("");
    try {
      const attributes = { key: paramKey.trim(), value: paramValue, sensitive: paramSensitive, hcl: paramHcl };
      if (editingParam === null) {
        await fetchApi(`/api/v2/policy-sets/${encodeURIComponent(setId)}/parameters`, {
          method: "POST",
          body: JSON.stringify({ data: { type: "vars", attributes } }),
        });
        toast.add({ title: "Parameter created", type: "success" });
      } else {
        await fetchApi(`/api/v2/policy-sets/${encodeURIComponent(setId)}/parameters/${encodeURIComponent(editingParam.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ data: { type: "vars", attributes } }),
        });
        toast.add({ title: "Parameter updated", type: "success" });
      }
      if (requestedSet.current !== setId) return;
      setParamDialogOpen(false);
      reload();
    } catch (err: unknown) {
      setParamFormError(err instanceof Error ? err.message : "Failed to save parameter");
    } finally {
      setSavingParam(false);
    }
  }

  async function deleteParam(p: Param): Promise<void> {
    if (!canManage) return;
    try {
      await fetchApi(`/api/v2/policy-sets/${encodeURIComponent(setId)}/parameters/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      if (requestedSet.current !== setId) return;
      setParams((prev): Param[] => prev.filter((x): boolean => x.id !== p.id));
      setParamToDelete(null);
      toast.add({ title: "Parameter deleted", type: "success" });
    } catch (err: unknown) {
      toast.add({ title: err instanceof Error ? err.message : "Failed to delete parameter", type: "error" });
      setParamToDelete(null);
    }
  }

  function openWorkspacePicker(): void {
    setAttachKind("workspaces");
    if (isGlobal) {
      setSelectedWorkspaces(new Set(attachedExclusionIds));
    } else {
      setSelectedWorkspaces(new Set(attachedWorkspaceIds));
    }
    setAttachWorkspaceOpen(true);
    setAttachProjectOpen(false);
  }

  function openProjectPicker(): void {
    setAttachKind("projects");
    setSelectedProjects(new Set(attachedProjectIds));
    setAttachProjectOpen(true);
    setAttachWorkspaceOpen(false);
  }
}

function HeaderLeft({ name, kind, isGlobal, isVcsBacked }: Readonly<{ name: string; kind: string; isGlobal: boolean; isVcsBacked: boolean }>): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <h1 className="text-3xl font-bold tracking-tight">{name}</h1>
      <Badge variant="outline">{kind.toUpperCase()}</Badge>
      {isGlobal && <Badge>Global</Badge>}
      {isVcsBacked && <Badge variant="secondary"><GitBranch className="size-3 mr-1" />VCS</Badge>}
    </div>
  );
}
