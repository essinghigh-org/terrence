import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { toast } from "../components/ui/toast";

/**
 * Permission grants offered in the fine-grained scope picker. Each maps to a
 * `permissions` key in the token scope. Read-only grants imply nothing else;
 * write grants do NOT imply their read counterpart (selectors are explicit).
 */
const PERMISSION_GROUPS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly grants: ReadonlyArray<{ readonly key: string; readonly label: string }>;
}> = [
  {
    id: "workspaces",
    label: "Workspaces",
    grants: [
      { key: "workspaces:read", label: "Read workspace metadata" },
      { key: "workspaces:write", label: "Create / edit / delete workspaces" },
    ],
  },
  {
    id: "runs",
    label: "Runs",
    grants: [
      { key: "runs:read", label: "Read run history" },
      { key: "runs:write", label: "Plan, apply, queue, and discard runs" },
    ],
  },
  {
    id: "state",
    label: "State",
    grants: [
      { key: "state:read", label: "Read state versions and outputs" },
      { key: "state:write", label: "Upload new state versions" },
    ],
  },
  {
    id: "variables",
    label: "Variables",
    grants: [
      { key: "variables:read", label: "Read workspace variable values" },
      { key: "variables:write", label: "Create and edit workspace variables" },
    ],
  },
  {
    id: "settings",
    label: "Organization settings",
    grants: [
      { key: "settings:read", label: "Read organization settings" },
      { key: "settings:write", label: "Modify organization settings" },
    ],
  },
];

type OrgOption = Readonly<{ id: string; name: string }>;
type ProjectOption = Readonly<{ id: string; name: string }>;
type WorkspaceOption = Readonly<{ id: string; name: string; projectName?: string }>;

export function TokenScopeDialog({
  open,
  onOpenChange,
  onCreated,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (token: { id: string; attributes: Record<string, unknown> }) => void;
}>): React.JSX.Element {
  const [description, setDescription] = useState("");
  const [fineGrained, setFineGrained] = useState(false);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [orgId, setOrgId] = useState("");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [selectedWorkspaces, setSelectedWorkspaces] = useState<Set<string>>(new Set());
  const [tagKey, setTagKey] = useState("");
  const [tagValue, setTagValue] = useState("");
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Load organizations when the dialog opens.
  useEffect((): void => {
    if (!open) return;
    setError("");
    void fetchApi("/organizations?page[size]=100").then((response: unknown): void => {
      const data = (response as { data?: OrgOption[] }).data ?? [];
      const sorted = [...data].sort((a, b): number => a.name.localeCompare(b.name));
      setOrgs(sorted);
      if (sorted.length > 0 && orgId === "") setOrgId(sorted[0]?.id ?? "");
    }).catch(() => { setError("Could not load organizations"); });
  }, [open]);

  // Load projects + workspaces for the selected org.
  useEffect((): void => {
    if (!open || orgId === "") { setProjects([]); setWorkspaces([]); return; }
    const orgName = orgs.find((o): boolean => o.id === orgId)?.name ?? orgId;
    setProjects([]);
    setWorkspaces([]);
    void fetchApi(`/organizations/${encodeURIComponent(orgName)}/projects?page[size]=100`).then((response: unknown): void => {
      const data = (response as { data?: ProjectOption[] }).data ?? [];
      setProjects(data);
    }).catch(() => { /* org may not expose projects */ });
    void fetchApi(`/organizations/${encodeURIComponent(orgName)}/workspaces?page[size]=100`).then((response: unknown): void => {
      const data = (response as { data?: WorkspaceOption[] }).data ?? [];
      setWorkspaces(data);
    }).catch(() => { /* workspaces may not be listable */ });
  }, [open, orgId, orgs]);

  const toggleProject = (id: string): void => {
    setSelectedProjects((prev): Set<string> => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleWorkspace = (id: string): void => {
    setSelectedWorkspaces((prev): Set<string> => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleGrant = (key: string): void => {
    setGranted((prev): Record<string, boolean> => ({ ...prev, [key]: !prev[key] }));
  };

  const reset = (): void => {
    setDescription("");
    setFineGrained(false);
    setOrgId("");
    setSelectedProjects(new Set());
    setSelectedWorkspaces(new Set());
    setTagKey("");
    setTagValue("");
    setGranted({});
    setError("");
  };

  const create = async (): Promise<void> => {
    setSaving(true);
    setError("");
    try {
      const attributes: Record<string, unknown> = { description: description.trim() === "" ? "API token" : description.trim() };
      if (fineGrained) {
        if (orgId === "") throw new Error("Select an organization");
        const scopes = {
          version: 1,
          orgs: [orgId],
          projects: selectedProjects.size > 0 ? [...selectedProjects] : null,
          workspaces: selectedWorkspaces.size > 0 ? [...selectedWorkspaces] : null,
          tags: tagKey.trim() !== "" ? [{ key: tagKey.trim(), value: tagValue.trim() }] : null,
          permissions: Object.fromEntries(Object.entries(granted).filter(([, v]): boolean => v)),
        };
        attributes["scopes"] = scopes;
      }
      const created = await fetchApi("/tokens", {
        method: "POST",
        body: JSON.stringify({ data: { attributes } }),
      }) as { data: { id: string; attributes: Record<string, unknown> } };
      onCreated(created.data);
      onOpenChange(false);
      reset();
      toast.add({
        title: fineGrained ? "Fine-grained token created" : "Token created",
        type: "success",
      });
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Failed to create token");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next: boolean): void => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create API token</DialogTitle>
          <DialogDescription>
            Fine-grained tokens can be scoped to specific organizations, projects,
            workspaces, and tag-matching workspaces, with per-action permission grants.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div className="space-y-1.5">
            <label htmlFor="token-desc" className="text-sm font-medium">Description</label>
            <Input id="token-desc" value={description} onInput={(e: React.SyntheticEvent<HTMLInputElement>): void => { setDescription(e.currentTarget.value); }} placeholder="e.g. CI/CD deploy token" />
          </div>

          <label className="flex items-center gap-3 text-sm font-medium">
            <Checkbox checked={fineGrained} onCheckedChange={(v: boolean): void => { setFineGrained(v); }} />
            <span>
              Fine-grained
              <span className="block text-[13px] font-normal text-muted-foreground mt-0.5">
                Restrict this token to selected resources and permissions. Legacy tokens have full access.
              </span>
            </span>
          </label>

          {fineGrained && (
            <>
              <div className="space-y-1.5">
                <label htmlFor="token-org" className="text-sm font-medium">Organization</label>
                <select
                  id="token-org"
                  className="flex h-9 w-full rounded-md border border-gray-300 bg-white px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                  value={orgId}
                  onChange={(e): void => { setOrgId(e.target.value); setSelectedProjects(new Set()); setSelectedWorkspaces(new Set()); }}
                >
                  {orgs.map((org): React.JSX.Element => (
                    <option key={org.id} value={org.id}>{org.name}</option>
                  ))}
                </select>
              </div>

              {/* Projects */}
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Projects <span className="text-muted-foreground font-normal">(none selected = all projects)</span></p>
                {projects.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No projects in this organization.</p>
                ) : (
                  <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border p-2">
                    {projects.map((project): React.JSX.Element => (
                      <label key={project.id} className="flex items-center gap-2 text-sm">
                        <Checkbox checked={selectedProjects.has(project.id)} onCheckedChange={(): void => { toggleProject(project.id); }} />
                        {project.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Workspaces */}
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Workspaces <span className="text-muted-foreground font-normal">(none selected = all workspaces in the selected projects)</span></p>
                {workspaces.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No workspaces in this organization.</p>
                ) : (
                  <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
                    {workspaces.map((workspace): React.JSX.Element => (
                      <label key={workspace.id} className="flex items-center gap-2 text-sm">
                        <Checkbox checked={selectedWorkspaces.has(workspace.id)} onCheckedChange={(): void => { toggleWorkspace(workspace.id); }} />
                        {workspace.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Tag filter */}
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Workspace tag filter <span className="text-muted-foreground font-normal">(optional)</span></p>
                <div className="flex gap-2">
                  <Input placeholder="key (e.g. environment)" value={tagKey} onInput={(e: React.SyntheticEvent<HTMLInputElement>): void => { setTagKey(e.currentTarget.value); }} className="h-9" />
                  <Input placeholder="value (e.g. production)" value={tagValue} onInput={(e: React.SyntheticEvent<HTMLInputElement>): void => { setTagValue(e.currentTarget.value); }} className="h-9" />
                </div>
                <p className="text-xs text-muted-foreground">Workspaces carrying this tag are included even if not selected above.</p>
              </div>

              {/* Permission grants */}
              <div className="space-y-2">
                <p className="text-sm font-medium">Permissions</p>
                {PERMISSION_GROUPS.map((group): React.JSX.Element => (
                  <div key={group.id} className="rounded-md border p-2.5">
                    <p className="mb-1 text-[13px] font-semibold text-muted-foreground">{group.label}</p>
                    <div className="space-y-1">
                      {group.grants.map((grant): React.JSX.Element => (
                        <label key={grant.key} className="flex items-center gap-2 text-sm">
                          <Checkbox checked={granted[grant.key] === true} onCheckedChange={(): void => { toggleGrant(grant.key); }} />
                          {grant.label}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {error !== "" && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" disabled={saving} onClick={(): void => { onOpenChange(false); reset(); }}>Cancel</Button>
          <Button type="button" disabled={saving || (fineGrained && orgId === "")} onClick={(): Promise<void> => create()}>
            {saving ? "Creating…" : "Create token"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
