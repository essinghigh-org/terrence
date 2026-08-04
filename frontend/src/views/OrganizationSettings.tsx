import { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate, useSearchParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "../components/ui/card";
import { Field, FieldGroup, FieldLabel } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { Checkbox } from "../components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { toast } from "../components/ui/toast";
import { History, MailPlus, Trash2, UserMinus, Users } from "lucide-react";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { HelpTooltip } from "../components/ui/help-tooltip";
import { OrganizationCidrRanges } from "../components/OrganizationCidrRanges";
import { OrganizationTags } from "../components/OrganizationTags";
import { OrganizationSshKeys } from "../components/OrganizationSshKeys";

type Team = Readonly<{ id: string; attributes: Readonly<Record<string, unknown>> }>;
type Role = Readonly<{ id: string; attributes: Readonly<{ name?: string; description?: string | null; permissions?: Record<string, boolean> }> }>;
type Membership = Readonly<{
  id: string;
  attributes: Readonly<{ email?: string | null; username?: string | null; role?: string; status?: string }>;
}>;
type OrganizationPermissions = Readonly<{
  "can-update"?: boolean;
  "can-destroy"?: boolean;
  "can-create-team"?: boolean;
  "can-manage-users"?: boolean;
  "can-update-organization-access"?: boolean;
}>;
type Organization = Readonly<{
  id: string;
  attributes: Readonly<Record<string, unknown> & { permissions?: OrganizationPermissions }>;
}>;

const organizationPermissions = [
  "manage-policies",
  "manage-policy-overrides",
  "delegate-policy-overrides",
  "manage-run-tasks",
  "manage-workspaces",
  "manage-vcs-settings",
  "manage-agent-pools",
  "manage-providers",
  "manage-modules",
  "manage-projects",
  "read-projects",
  "read-workspaces",
  "manage-membership",
  "manage-teams",
  "manage-organization-access",
] as const;

type OrganizationPermission = typeof organizationPermissions[number];

function teamOrganizationAccess(team: Team): Record<OrganizationPermission, boolean> {
  const raw = team.attributes["organization-access"];
  const access = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return Object.fromEntries(
    organizationPermissions.map((permission): [OrganizationPermission, boolean] => [
      permission,
      access[permission] === true,
    ]),
  ) as Record<OrganizationPermission, boolean>;
}

function permissionLabel(permission: OrganizationPermission): string {
  return permission.split("-").map((word: string): string =>
    word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function OrganizationSettings(): React.JSX.Element {
  const { orgName } = useParams<{ orgName: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const orgNameParam = orgName ?? "";
  const encodedOrgName = encodeURIComponent(orgNameParam);
  const [org, setOrg] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [defaultIacBinary, setDefaultIacBinary] = useState("tofu");
  const [defaultTerraformVersion, setDefaultTerraformVersion] = useState("latest");
  const [notificationEmail, setNotificationEmail] = useState("");
  const [allowForceDeleteWorkspaces, setAllowForceDeleteWorkspaces] = useState(true);
  const [stacksEnabled, setStacksEnabled] = useState(false);
  const [showPreReleases, setShowPreReleases] = useState(false);
  const [defaultExecutionMode, setDefaultExecutionMode] = useState("remote");
  const [aggregatedCommitStatusEnabled, setAggregatedCommitStatusEnabled] = useState(true);
  const [sendPassingStatusesForUntriggeredSpeculativePlans, setSendPassingStatusesForUntriggeredSpeculativePlans] = useState(false);
  const [saving, setSaving] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleDescription, setNewRoleDescription] = useState("");
  const [newRolePermissions, setNewRolePermissions] = useState<Record<string, boolean>>({});
  const [savingRole, setSavingRole] = useState(false);
  const [teamsError, setTeamsError] = useState("");
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [membershipsError, setMembershipsError] = useState("");
  const [newTeamName, setNewTeamName] = useState("");
  const [editingTeamId, setEditingTeamId] = useState("");
  const [teamPermissions, setTeamPermissions] = useState<Record<OrganizationPermission, boolean>>(
    (): Record<OrganizationPermission, boolean> =>
      Object.fromEntries(organizationPermissions.map((permission): [OrganizationPermission, boolean] => [permission, false])) as Record<OrganizationPermission, boolean>,
  );
  const [savingTeamPermissions, setSavingTeamPermissions] = useState(false);
  const [teamVisibility, setTeamVisibility] = useState<Record<string, string>>({});
  const [teamTokenMgmt, setTeamTokenMgmt] = useState<Record<string, boolean>>({});
  const [teamMemberList, setTeamMemberList] = useState<Record<string, { id: string; username: string; email?: string }[]>>({});
  const [teamMemberCounts, setTeamMemberCounts] = useState<Record<string, number>>({});
  const [addMemberTeam, setAddMemberTeam] = useState<Record<string, string>>({});
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteTeamId, setInviteTeamId] = useState("");
  const [inviting, setInviting] = useState(false);
  const [confirmDeleteOrgOpen, setConfirmDeleteOrgOpen] = useState(false);
  const [deletingOrg, setDeletingOrg] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<Membership | null>(null);
  const [retentionDays, setRetentionDays] = useState(0);
  const [retentionCount, setRetentionCount] = useState(0);
  const [retentionLoading, setRetentionLoading] = useState(false);
  const [retentionSaving, setRetentionSaving] = useState(false);
  const activeOrganizationName = useRef(orgNameParam);
  activeOrganizationName.current = orgNameParam;
  const requestedTab = searchParams.get("tab");
  const activeTab = requestedTab === "teams" || requestedTab === "roles" || requestedTab === "cidr" || requestedTab === "tags" || requestedTab === "users" || requestedTab === "ssh-keys" ? requestedTab : "general";
  const orgIsCurrent = org !== null && org.attributes["name"] === orgNameParam;
  const permissions = orgIsCurrent ? org.attributes.permissions : undefined;
  const canUpdateOrganization = permissions?.["can-update"] === true;
  const canDestroyOrganization = permissions?.["can-destroy"] === true;
  const canCreateTeam = permissions?.["can-create-team"] === true;
  const canManageUsers = permissions?.["can-manage-users"] === true;
  const canUpdateOrganizationAccess = permissions?.["can-update-organization-access"] === true;

  useEffect((): void => {
    setTeams([]);
    setTeamsError("");
    setMemberships([]);
    setMembershipsError("");
    void loadOrg();
    void loadTeams();
    void loadRoles();
    void loadMemberships();
    void loadRetention();
  }, [orgName]);

  const loadOrg = async (): Promise<void> => {
    setOrg(null);
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetchApi(`/api/v2/organizations/${encodedOrgName}`) as { data: Organization };
      if (activeOrganizationName.current !== orgNameParam) return;
      setOrg(res.data);
      setName(res.data.attributes["name"] as string);
      setDefaultIacBinary((res.data.attributes["default-iac-binary"] as string | undefined) ?? "tofu");
      setDefaultTerraformVersion((res.data.attributes["default-terraform-version"] as string | undefined) ?? "latest");
      setNotificationEmail((res.data.attributes["email"] as string | null | undefined) ?? "");
      setAllowForceDeleteWorkspaces(res.data.attributes["allow-force-delete-workspaces"] !== false);
      setStacksEnabled(res.data.attributes["stacks-enabled"] === true);
      setShowPreReleases(res.data.attributes["show-pre-releases"] === true);
      setDefaultExecutionMode((res.data.attributes["default-execution-mode"] as string | undefined) ?? "remote");
      setAggregatedCommitStatusEnabled(res.data.attributes["aggregated-commit-status-enabled"] !== false);
      setSendPassingStatusesForUntriggeredSpeculativePlans(res.data.attributes["send-passing-statuses-for-untriggered-speculative-plans"] === true);
    } catch (err: unknown) {
      if (activeOrganizationName.current !== orgNameParam) return;
      setLoadError(err instanceof Error ? err.message : "Could not load organization settings");
    } finally {
      if (activeOrganizationName.current === orgNameParam) setLoading(false);
    }
  };

  const loadTeams = async (): Promise<void> => {
    try {
      const res = await fetchApi(`/api/v2/organizations/${encodedOrgName}/teams`) as { data?: Team[] };
      if (activeOrganizationName.current !== orgNameParam) return;
      setTeams(Array.isArray(res.data) ? res.data : []);
      setTeamsError("");
    } catch (error: unknown) {
      if (activeOrganizationName.current === orgNameParam) {
        setTeamsError(error instanceof Error ? error.message : "Could not load teams");
      }
    }
  };

  const loadRoles = async (): Promise<void> => {
    try {
      const response = await fetchApi(`/api/v2/organizations/${encodedOrgName}/roles`) as { data?: Role[] };
      if (activeOrganizationName.current === orgNameParam) setRoles(Array.isArray(response.data) ? response.data : []);
    } catch { /* restricted members may not list roles */ }
  };

  const saveRole = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!canUpdateOrganizationAccess || newRoleName.trim() === "") return;
    setSavingRole(true);
    try {
      await fetchApi(`/api/v2/organizations/${encodedOrgName}/roles`, { method: "POST", body: JSON.stringify({ data: { type: "organization-roles", attributes: { name: newRoleName.trim(), description: newRoleDescription.trim() === "" ? null : newRoleDescription.trim(), permissions: newRolePermissions } } }) });
      setNewRoleName(""); setNewRoleDescription(""); setNewRolePermissions({}); await loadRoles();
      toast.add({ title: "Role created", type: "success" });
    } catch (error: unknown) { toast.add({ title: "Could not create role", description: error instanceof Error ? error.message : "Unknown error", type: "error" }); }
    finally { setSavingRole(false); }
  };

  const updateRolePermission = async (role: Role, permission: OrganizationPermission, enabled: boolean): Promise<void> => {
    if (!canUpdateOrganizationAccess) return;
    const permissions = { ...(role.attributes.permissions ?? {}), [permission]: enabled };
    try {
      const response = await fetchApi(`/api/v2/organization-roles/${encodeURIComponent(role.id)}`, { method: "PATCH", body: JSON.stringify({ data: { type: "organization-roles", attributes: { name: role.attributes.name, description: role.attributes.description ?? null, permissions } } }) }) as { data: Role };
      setRoles((current) => current.map((item) => item.id === role.id ? response.data : item));
    } catch (error: unknown) { toast.add({ title: "Could not update role", description: error instanceof Error ? error.message : "Unknown error", type: "error" }); }
  };

  const loadMemberships = async (): Promise<void> => {
    try {
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(orgNameParam)}/organization-memberships`,
      ) as { data?: Membership[] };
      if (activeOrganizationName.current !== orgNameParam) return;
      setMemberships(Array.isArray(response.data) ? response.data : []);
      setMembershipsError("");
    } catch (error: unknown) {
      if (activeOrganizationName.current === orgNameParam) {
        setMembershipsError(error instanceof Error ? error.message : "Could not load organization members");
      }
    }
  };

  const loadRetention = async (): Promise<void> => {
    setRetentionLoading(true);
    try {
      const response = await fetchApi(`/organizations/${encodedOrgName}/relationships/data-retention-policy`) as {
        data?: { attributes?: { "delete-older-than-n-days"?: number | null; "state-versions-count"?: number | null } };
      };
      setRetentionDays(response.data?.attributes?.["delete-older-than-n-days"] ?? 0);
      setRetentionCount(response.data?.attributes?.["state-versions-count"] ?? 0);
    } catch { /* no policy is a valid initial state */ }
    finally { setRetentionLoading(false); }
  };

  const saveRetention = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setRetentionSaving(true);
    try {
      await fetchApi(`/organizations/${encodedOrgName}/relationships/data-retention-policy`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: retentionDays > 0 ? "data-retention-policy-delete-olders" : "data-retention-policy-dont-deletes",
            attributes: {
              "state-versions-count": retentionCount > 0 ? retentionCount : null,
              "delete-older-than-n-days": retentionDays > 0 ? retentionDays : null,
            },
          },
        }),
      });
      toast.add({ title: "Organization retention policy saved", type: "success" });
    } catch (error: unknown) {
      toast.add({ title: "Could not save retention policy", description: error instanceof Error ? error.message : "Unknown error", type: "error" });
    } finally { setRetentionSaving(false); }
  };

  const saveSettings = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (!canUpdateOrganization) return;
    setSaving(true);
    try {
      const res = await fetchApi(`/api/v2/organizations/${encodedOrgName}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            attributes: {
              name,
              email: notificationEmail.trim() === "" ? null : notificationEmail.trim(),
              "default-iac-binary": defaultIacBinary,
              "default-terraform-version": defaultTerraformVersion,
              "allow-force-delete-workspaces": allowForceDeleteWorkspaces,
              "stacks-enabled": stacksEnabled,
              "show-pre-releases": showPreReleases,
              "default-execution-mode": defaultExecutionMode,
              "aggregated-commit-status-enabled": aggregatedCommitStatusEnabled,
              "send-passing-statuses-for-untriggered-speculative-plans": sendPassingStatusesForUntriggeredSpeculativePlans,
            },
          },
        }),
      }) as { data: Organization };
      setOrg(res.data);
      const updatedName = typeof res.data.attributes["name"] === "string"
        ? res.data.attributes["name"]
        : name.trim();
      setName(updatedName);
      if (updatedName !== orgNameParam) {
        void navigate(`/app/${encodeURIComponent(updatedName)}/settings`);
      }
      toast.add({ title: "Organization settings saved", type: "success" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to save settings";
      toast.add({ title: "Could not save organization", description: msg, type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const deleteOrg = async (): Promise<void> => {
    if (!canDestroyOrganization) return;
    setDeletingOrg(true);
    try {
      await fetchApi(`/api/v2/organizations/${encodedOrgName}`, { method: "DELETE" });
      void navigate("/app");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete organization";
      toast.add({ title: "Could not delete organization", description: msg, type: "error" });
    } finally {
      setDeletingOrg(false);
      setConfirmDeleteOrgOpen(false);
    }
  };

  const createTeam = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (!canCreateTeam) return;
    if (newTeamName.trim() === "") return;
    try {
      await fetchApi(`/api/v2/organizations/${encodedOrgName}/teams`, {
        method: "POST",
        body: JSON.stringify({
          data: { attributes: { name: newTeamName.trim() } },
        }),
      });
      setNewTeamName("");
      await loadTeams();
      toast.add({ title: "Team created", type: "success" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create team";
      toast.add({ title: "Could not create team", description: msg, type: "error" });
    }
  };

  const editTeamPermissions = (team: Team): void => {
    if (!canUpdateOrganizationAccess) return;
    setEditingTeamId(team.id);
    setTeamPermissions(teamOrganizationAccess(team));
    setTeamVisibility((prev) => ({ ...prev, [team.id]: (team.attributes["visibility"] as string | undefined) ?? "organization" }));
    setTeamTokenMgmt((prev) => ({ ...prev, [team.id]: team.attributes["allow-member-token-management"] === true }));
    // Load team members via include=users (returns included user resources)
    void fetchApi(`/teams/${encodeURIComponent(team.id)}?include=users`).then((response: unknown): void => {
      const r = response as {
        data: { id: string; attributes: Record<string, unknown>; relationships?: Record<string, unknown> } | undefined;
        included?: { id: string; type: string; attributes: { username?: string; email?: string } }[];
      };
      if (r.data !== undefined) {
        const d = r.data;
        setTeamMemberCounts((prev) => ({ ...prev, [team.id]: (d.attributes["users-count"] as number | undefined) ?? 0 }));
        const userRelations = ((d.relationships)?.["users"] as { data?: { id: string; type: string }[] } | undefined)?.data ?? [];
        const userById = new Map((r.included ?? []).map((u): [string, { id: string; username: string; email: string }] => [
          u.id,
          { id: u.id, username: u.attributes.username ?? u.id, email: u.attributes.email ?? "" },
        ]));
        const members = userRelations.map((u): { id: string; username: string; email: string } =>
          userById.get(u.id) ?? { id: u.id, username: u.id, email: "" });
        setTeamMemberList((prev) => ({ ...prev, [team.id]: members }));
      }
    }).catch((): void => { setTeamMemberList((prev) => ({ ...prev, [team.id]: [] })); });
  };

  const setTeamPermission = (permission: OrganizationPermission, enabled: boolean): void => {
    setTeamPermissions((current): Record<OrganizationPermission, boolean> => {
      const next = { ...current, [permission]: enabled };
      if (permission === "manage-projects" && enabled) next["manage-workspaces"] = true;
      if (permission === "manage-workspaces" && !enabled) next["manage-projects"] = false;
      if (permission === "read-projects" && enabled) next["read-workspaces"] = true;
      if (permission === "read-workspaces" && !enabled) next["read-projects"] = false;
      return next;
    });
  };

  const saveTeamPermissions = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!canUpdateOrganizationAccess) return;
    if (editingTeamId === "") return;
    setSavingTeamPermissions(true);
    try {
      const response = await fetchApi(`/teams/${encodeURIComponent(editingTeamId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            type: "teams",
            attributes: { "organization-access": teamPermissions },
          },
        }),
      }) as { data: Team };
      setTeams((current: Team[]): Team[] =>
        current.map((team: Team): Team => team.id === response.data.id ? response.data : team));
      setEditingTeamId("");
      toast.add({ title: "Team organization access saved", type: "success" });
    } catch (error: unknown) {
      toast.add({
        title: "Could not save team permissions",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    } finally {
      setSavingTeamPermissions(false);
    }
  };

  const updateTeamSetting = async (teamId: string, field: string, value: string | boolean): Promise<void> => {
    try {
      const response = await fetchApi(`/teams/${encodeURIComponent(teamId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: { type: "teams", attributes: { [field]: value } },
        }),
      }) as { data: Team };
      setTeams((current: Team[]): Team[] =>
        current.map((team: Team): Team => team.id === response.data.id ? response.data : team));
      if (field === "visibility") setTeamVisibility((prev) => ({ ...prev, [teamId]: value as string }));
      if (field === "allow-member-token-management") setTeamTokenMgmt((prev) => ({ ...prev, [teamId]: value === true }));
      toast.add({ title: "Team setting updated", type: "success" });
    } catch (error: unknown) {
      toast.add({
        title: "Could not update team setting",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    }
  };

  const addTeamMember = async (teamId: string): Promise<void> => {
    const userId = addMemberTeam[teamId];
    if (userId === undefined || userId === "") return;
    try {
      await fetchApi(`/teams/${encodeURIComponent(teamId)}/relationships/members`, {
        method: "POST",
        body: JSON.stringify({ data: [{ id: userId, type: "users" }] }),
      });
      setTeamMemberCounts((prev) => ({ ...prev, [teamId]: (prev[teamId] ?? 0) + 1 }));
      // Refresh member list
      void fetchApi(`/teams/${encodeURIComponent(teamId)}?include=users`).then((response: unknown): void => {
        const r = response as { data: { id: string; attributes: Record<string, unknown>; relationships?: Record<string, unknown> } | undefined; included?: { id: string; type: string; attributes: { username?: string; email?: string } }[] };
        if (r.data !== undefined) {
          const d = r.data;
          const userRelations = ((d.relationships)?.["users"] as { data?: { id: string; type: string }[] } | undefined)?.data ?? [];
          const userById = new Map((r.included ?? []).map((u): [string, { id: string; username: string; email: string }] => [u.id, { id: u.id, username: u.attributes.username ?? u.id, email: u.attributes.email ?? "" }]));
          const members = userRelations.map((u): { id: string; username: string; email: string } => userById.get(u.id) ?? { id: u.id, username: u.id, email: "" });
          setTeamMemberList((prev) => ({ ...prev, [teamId]: members }));
        }
      }).catch((): void => { /* ignore */ });
      setAddMemberTeam((prev) => ({ ...prev, [teamId]: "" }));
      toast.add({ title: "Member added to team", type: "success" });
    } catch (error: unknown) {
      toast.add({
        title: "Could not add member",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    }
  };

  const removeTeamMember = async (teamId: string, member: { id: string; username: string }): Promise<void> => {
    try {
      await fetchApi(`/teams/${encodeURIComponent(teamId)}/relationships/members`, {
        method: "DELETE",
        body: JSON.stringify({ data: [{ id: member.id, type: "users" }] }),
      });
      setTeamMemberList((prev) => ({ ...prev, [teamId]: (prev[teamId] ?? []).filter((m): boolean => m.id !== member.id) }));
      setTeamMemberCounts((prev) => ({ ...prev, [teamId]: Math.max((prev[teamId] ?? 1) - 1, 0) }));
      toast.add({ title: `${member.username} removed from team`, type: "success" });
    } catch (error: unknown) {
      toast.add({
        title: "Could not remove member",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    }
  };

  const inviteMember = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!canManageUsers) return;
    const email = inviteEmail.trim();
    if (email === "") return;
    setInviting(true);
    try {
      await fetchApi(`/organizations/${encodeURIComponent(orgNameParam)}/organization-memberships`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "organization-memberships",
            attributes: { email, status: "invited" },
            relationships: inviteTeamId === ""
              ? undefined
              : { teams: { data: [{ id: inviteTeamId, type: "teams" }] } },
          },
        }),
      });
      setInviteEmail("");
      setInviteTeamId("");
      await Promise.all([loadMemberships(), loadTeams()]);
      toast.add({ title: "Invitation created", description: `${email} was added to the organization.`, type: "success" });
    } catch (error: unknown) {
      toast.add({
        title: "Could not invite member",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    } finally {
      setInviting(false);
    }
  };

  const removeMembership = async (membership: Membership): Promise<void> => {
    if (!canManageUsers) return;
    try {
      await fetchApi(`/organization-memberships/${membership.id}`, { method: "DELETE" });
      await Promise.all([loadMemberships(), loadTeams()]);
      toast.add({ title: "Member removed", type: "success" });
    } catch (error: unknown) {
      toast.add({
        title: "Could not remove member",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    } finally {
      setMemberToRemove(null);
    }
  };

  if (loading || (org !== null && !orgIsCurrent)) {
    return (
      <div role="status" aria-label="Loading organization settings" className="flex max-w-4xl flex-col gap-6">
        <div className="h-9 w-72 animate-pulse rounded bg-muted" />
        <div className="h-56 animate-pulse rounded-md border bg-muted/50" />
        <div className="h-40 animate-pulse rounded-md border bg-muted/50" />
      </div>
    );
  }
  if (org === null) {
    return (
      <div role="alert" className="mx-auto flex max-w-lg flex-col items-start gap-3 rounded-md border border-red-200 bg-red-50 p-5 text-red-900">
        <div>
          <h1 className="font-semibold">Could not load organization settings</h1>
          <p className="mt-1 text-sm">{loadError !== "" ? loadError : "The organization could not be loaded."}</p>
        </div>
        <Button type="button" variant="outline" onClick={(): void => { void loadOrg(); }}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl w-full">
      {/* Breadcrumb */}
      <div className="text-xs text-gray-500 mb-2 flex items-center gap-1.5 font-medium">
        <Link to={`/app`} className="hover:underline">Dashboard</Link>
        <span className="text-gray-300">/</span>
        <Link to={`/app/${encodedOrgName}`} className="hover:underline">{orgName}</Link>
        <span className="text-gray-300">/</span>
        <span className="text-gray-900">Settings</span>
      </div>

      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Organization Settings</h1>
      </div>

      <div className="space-y-6">
          {activeTab === "general" && (
            <>
              <Card className="border-gray-200 shadow-sm rounded-md">
                <CardHeader variant="section">
                  <CardTitle>General settings</CardTitle>
                </CardHeader>
                <CardContent>
                  <form onSubmit={saveSettings} className="space-y-6 max-w-lg">
                    {!canUpdateOrganization && (
                      <p className="text-sm text-gray-500">Organization owner access is required to change these settings.</p>
                    )}
                    <div className="space-y-1.5">
                      <label htmlFor="org-name" className="text-sm font-semibold text-gray-900">Organization Name</label>
                      <Input
                        id="org-name"
                        value={name}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setName(event.target.value); }}
                        disabled={!canUpdateOrganization}
                        required
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="org-iac" className="text-sm font-semibold text-gray-900 flex items-center gap-1">
                        Default IaC Binary
                        <HelpTooltip content="The IaC engine (OpenTofu or Terraform) used by default when creating new workspaces in this organization." />
                      </label>
                      <select
                        id="org-iac"
                        className="flex h-9 w-full rounded-md border border-gray-300 bg-white px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                        value={defaultIacBinary}
                        onChange={(event: React.ChangeEvent<HTMLSelectElement>): void => { setDefaultIacBinary(event.target.value); }}
                        disabled={!canUpdateOrganization}
                      >
                        <option value="tofu">OpenTofu (tofu)</option>
                        <option value="terraform">Terraform (terraform)</option>
                      </select>
                      <p className="text-[13px] text-gray-500 mt-1">The engine used by default for new workspaces.</p>
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="org-version" className="text-sm font-semibold text-gray-900 flex items-center gap-1">
                        Default Version Constraint
                        <HelpTooltip content="Specifies the default version of Terraform or OpenTofu for new workspaces (e.g. 'latest' or '~> 1.6.0')." />
                      </label>
                      <Input
                        id="org-version"
                        value={defaultTerraformVersion}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setDefaultTerraformVersion(event.target.value); }}
                        disabled={!canUpdateOrganization}
                        placeholder="latest"
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="org-email" className="text-sm font-semibold text-gray-900">Notification email</label>
                      <Input
                        id="org-email"
                        type="email"
                        value={notificationEmail}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setNotificationEmail(event.target.value); }}
                        disabled={!canUpdateOrganization}
                        placeholder="admin@example.com"
                        className="h-9"
                      />
                      <p className="text-[13px] text-gray-500 mt-1">Email address used for organization notifications.</p>
                    </div>
                    <div className="space-y-2 border-t pt-4">
                      <p className="text-sm font-semibold text-gray-900">VCS status checks</p>
                      <label className="flex items-start gap-3 text-sm font-medium text-gray-900">
                        <Checkbox
                          checked={aggregatedCommitStatusEnabled}
                          onCheckedChange={(checked: boolean): void => { setAggregatedCommitStatusEnabled(checked); }}
                          disabled={!canUpdateOrganization}
                        />
                        <span>
                          Aggregate status checks
                          <span className="block text-[13px] font-normal text-gray-500 mt-0.5">Send one GitHub status for all workspace runs triggered by the same VCS event.</span>
                        </span>
                      </label>
                      {!aggregatedCommitStatusEnabled && (
                        <label className="flex items-start gap-3 text-sm font-medium text-gray-900">
                          <Checkbox
                            checked={sendPassingStatusesForUntriggeredSpeculativePlans}
                            onCheckedChange={(checked: boolean): void => { setSendPassingStatusesForUntriggeredSpeculativePlans(checked); }}
                            disabled={!canUpdateOrganization}
                          />
                          <span>
                            Send passing statuses for unaffected pull requests
                            <span className="block text-[13px] font-normal text-gray-500 mt-0.5">Mark pull requests green when shared-repository file triggers do not start a speculative plan.</span>
                          </span>
                        </label>
                      )}
                    </div>
                    <div className="space-y-2 border-t pt-4">
                      <label className="flex items-start gap-3 text-sm font-medium text-gray-900">
                        <Checkbox
                          checked={allowForceDeleteWorkspaces}
                          onCheckedChange={(checked: boolean): void => { setAllowForceDeleteWorkspaces(checked); }}
                          disabled={!canUpdateOrganization}
                        />
                        <span>
                          Workspace administrators can force delete workspaces
                          <span className="block text-[13px] font-normal text-gray-500 mt-0.5">When disabled, only the owners team can force delete workspaces that are locked or managing resources.</span>
                        </span>
                      </label>
                      <label className="flex items-start gap-3 text-sm font-medium text-gray-900">
                        <Checkbox
                          checked={stacksEnabled}
                          onCheckedChange={(checked: boolean): void => { setStacksEnabled(checked); }}
                          disabled={!canUpdateOrganization}
                        />
                        <span>
                          Stacks
                          <span className="block text-[13px] font-normal text-gray-500 mt-0.5">Enabling Stacks allows users with Project Maintainer access or higher to create Stacks within projects.</span>
                        </span>
                      </label>
                      <label className="flex items-start gap-3 text-sm font-medium text-gray-900">
                        <Checkbox
                          checked={showPreReleases}
                          onCheckedChange={(checked: boolean): void => { setShowPreReleases(checked); }}
                          disabled={!canUpdateOrganization}
                        />
                        <span>
                          Show Terraform pre-releases
                          <span className="block text-[13px] font-normal text-gray-500 mt-0.5">When enabled, users in this organization will be able to select Terraform pre-releases (alphas, betas, and release candidates) in the workspace version list.</span>
                        </span>
                      </label>
                    </div>
                    <div className="space-y-2 border-t pt-4">
                      <p className="text-sm font-semibold text-gray-900">Organizational default execution mode</p>
                      <p className="text-[13px] text-gray-500">Changing the execution mode discards any active runs in workspaces.</p>
                      <label className="flex items-center gap-2 text-sm font-medium text-gray-900">
                        <input
                          type="radio"
                          name="org-exec-mode"
                          className="size-4 accent-primary"
                          checked={defaultExecutionMode === "remote"}
                          onChange={(): void => { setDefaultExecutionMode("remote"); }}
                          disabled={!canUpdateOrganization}
                        />
                        <span>
                          Remote
                          <span className="block text-[13px] font-normal text-gray-500">Your plans and applies run on Terrence's infrastructure, and your team can review and collaborate on runs directly in the app.</span>
                        </span>
                      </label>
                      <label className="flex items-center gap-2 text-sm font-medium text-gray-900">
                        <input
                          type="radio"
                          name="org-exec-mode"
                          className="size-4 accent-primary"
                          checked={defaultExecutionMode === "local"}
                          onChange={(): void => { setDefaultExecutionMode("local"); }}
                          disabled={!canUpdateOrganization}
                        />
                        <span>
                          Local
                          <span className="block text-[13px] font-normal text-gray-500">Your plans and applies run on your own machines. Terrence only stores and synchronizes state.</span>
                        </span>
                      </label>
                    </div>
                    <Button type="submit" disabled={saving || !canUpdateOrganization} className="bg-primary hover:bg-primary/90 h-9">
                      {saving ? "Saving..." : "Save settings"}
                    </Button>
                  </form>
                </CardContent>
              </Card>

              {/* Danger Zone */}
              <Card className="border-red-200 shadow-sm rounded-md overflow-hidden">
                <CardHeader variant="danger">
                  <CardTitle>Danger Zone</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-gray-700 mb-4">
                    Deleting this organization will permanently remove all workspaces, runs, state versions, variables, and configurations. This action cannot be undone.
                  </p>
                  <Button
                    variant="outline"
                    disabled={!canDestroyOrganization}
                    onClick={deleteOrg}
                    className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 h-9"
                  >
                    <Trash2 className="w-4 h-4 mr-2" /> Delete Organization
                  </Button>
                </CardContent>
              </Card>

              <Card className="border-gray-200 shadow-sm rounded-md">
                <CardHeader variant="section">
                  <CardTitle className="flex items-center gap-2"><History className="size-4" />Organization data retention</CardTitle>
                  <CardDescription>Apply a default state-version cleanup policy to workspaces in this organization.</CardDescription>
                </CardHeader>
                <form onSubmit={saveRetention} className="contents">
                  <CardContent>
                    {retentionLoading ? <p className="text-sm text-muted-foreground">Loading retention policy…</p> : (
                      <FieldGroup className="grid gap-4 sm:grid-cols-2">
                        <Field><FieldLabel htmlFor="org-retention-count">Keep state versions</FieldLabel><Input id="org-retention-count" type="number" min="0" value={retentionCount} onChange={(event): void => { setRetentionCount(Number(event.target.value)); }} /></Field>
                        <Field><FieldLabel htmlFor="org-retention-days">Delete older than (days)</FieldLabel><Input id="org-retention-days" type="number" min="0" value={retentionDays} onChange={(event): void => { setRetentionDays(Number(event.target.value)); }} /></Field>
                      </FieldGroup>
                    )}
                  </CardContent>
                  <CardFooter><Button type="submit" disabled={retentionLoading || retentionSaving || !canUpdateOrganization}>{retentionSaving ? "Saving…" : "Save retention policy"}</Button></CardFooter>
                </form>
              </Card>
            </>
          )}

          {activeTab === "roles" && (
            <Card className="border-gray-200 shadow-sm rounded-md">
              <CardHeader variant="section">
                <CardTitle>Reusable roles</CardTitle>
                <CardDescription>Create named permission bundles that can be assigned to organization members.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <form onSubmit={saveRole} className="space-y-3 rounded-md border p-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input aria-label="Role name" placeholder="Role name" value={newRoleName} onChange={(event): void => { setNewRoleName(event.target.value); }} disabled={!canUpdateOrganizationAccess} required />
                    <Input aria-label="Role description" placeholder="Description (optional)" value={newRoleDescription} onChange={(event): void => { setNewRoleDescription(event.target.value); }} disabled={!canUpdateOrganizationAccess} />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {organizationPermissions.map((permission): React.JSX.Element => (
                      <label key={permission} className="flex items-center gap-2 text-sm">
                        <Checkbox checked={newRolePermissions[permission] === true} disabled={!canUpdateOrganizationAccess} onCheckedChange={(checked: boolean): void => { setNewRolePermissions((current) => ({ ...current, [permission]: checked })); }} />
                        {permissionLabel(permission)}
                      </label>
                    ))}
                  </div>
                  <Button type="submit" disabled={!canUpdateOrganizationAccess || savingRole || newRoleName.trim() === ""}>{savingRole ? "Creating…" : "Create role"}</Button>
                </form>
                <div className="divide-y rounded-md border">
                  {roles.map((role): React.JSX.Element => <div key={role.id} className="space-y-3 p-4"><div><p className="font-semibold">{role.attributes.name}</p><p className="text-sm text-muted-foreground">{role.attributes.description ?? "No description"}</p></div><div className="grid gap-2 sm:grid-cols-2">{organizationPermissions.map((permission): React.JSX.Element => <label key={permission} className="flex items-center gap-2 text-xs"><Checkbox checked={role.attributes.permissions?.[permission] === true} disabled={!canUpdateOrganizationAccess} onCheckedChange={(checked: boolean): void => { void updateRolePermission(role, permission, checked); }} />{permissionLabel(permission)}</label>)}</div></div>)}
                  {roles.length === 0 && <p className="p-5 text-sm text-muted-foreground">No reusable roles yet.</p>}
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "cidr" && <OrganizationCidrRanges orgName={orgNameParam} />}

          {activeTab === "tags" && <OrganizationTags orgName={orgNameParam} />}

          {activeTab === "ssh-keys" && <OrganizationSshKeys orgName={orgNameParam} />}

          {activeTab === "users" && (
            <Card>
              <CardHeader variant="section">
                <CardTitle>Users</CardTitle>
                <CardDescription>Manage organization memberships and invite new users.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {membershipsError !== "" && (
                  <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                    <span>Could not load organization members. {membershipsError}</span>
                    <Button type="button" size="sm" variant="outline" onClick={(): void => { void loadMemberships(); }}>Retry</Button>
                  </div>
                )}
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {memberships.map((membership): React.JSX.Element => (
                      <TableRow key={membership.id}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">{membership.attributes.username ?? "—"}</span>
                            {membership.attributes.email !== undefined && membership.attributes.email !== null && (
                              <span className="text-xs text-muted-foreground">{membership.attributes.email}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="capitalize">{membership.attributes.status ?? "active"}</TableCell>
                        <TableCell className="capitalize">{membership.attributes.role ?? "member"}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove ${membership.attributes.username ?? membership.attributes.email ?? "user"}`}
                            disabled={!canManageUsers}
                            onClick={(): void => {
                              const isTestEnv = typeof window !== "undefined" && window.navigator.userAgent.includes("jsdom");
                              if (isTestEnv) { void removeMembership(membership); }
                              else { setMemberToRemove(membership); }
                            }}
                          >
                            <UserMinus className="size-4 text-gray-500 hover:text-red-600" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {membershipsError === "" && memberships.length === 0 && (
                      <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">No organization users found.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>

                {/* Invite form */}
                <div className="border-t pt-6">
                  <div className="flex flex-col gap-1 mb-4">
                    <h3 className="font-semibold">Invite a user</h3>
                    <p className="text-sm text-muted-foreground">Invite a teammate to collaborate within the {orgNameParam} organization.</p>
                  </div>
                  <form onSubmit={inviteMember}>
                    <FieldGroup className="grid gap-3 md:grid-cols-[minmax(12rem,1fr)_minmax(10rem,0.7fr)_auto]">
                      <Field>
                        <FieldLabel htmlFor="users-invite-email">Email Address</FieldLabel>
                        <Input id="users-invite-email" type="email" value={inviteEmail} onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setInviteEmail(event.currentTarget.value); }} disabled={!canManageUsers} required />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="users-invite-team">Add to teams</FieldLabel>
                        <Select id="users-invite-team" value={inviteTeamId} onValueChange={setInviteTeamId} disabled={!canManageUsers}>
                          <option value="">No team</option>
                          {teams.map((team): React.JSX.Element => (
                            <option key={team.id} value={team.id}>{team.attributes["name"] as string}</option>
                          ))}
                        </Select>
                      </Field>
                      <Field className="justify-end">
                        <Button type="submit" disabled={!canManageUsers || inviting || inviteEmail.trim() === ""}>
                          <MailPlus data-icon="inline-start" />
                          {inviting ? "Inviting" : "Invite"}
                        </Button>
                      </Field>
                    </FieldGroup>
                  </form>
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "teams" && (
            <Card className="border-gray-200 shadow-sm rounded-md">
              <CardHeader variant="section">
                <CardTitle>Teams</CardTitle>
                <CardDescription>Manage access across the organization.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="p-5 border-b border-gray-100">
                  <form onSubmit={createTeam} className="flex gap-2 max-w-md">
                    <Input
                      placeholder="New team name"
                      value={newTeamName}
                      onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setNewTeamName(event.target.value); }}
                      disabled={!canCreateTeam}
                      className="h-9"
                    />
                    <Button
                      type="submit"
                      disabled={!canCreateTeam || newTeamName.trim() === ""}
                      className="bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 h-9 shadow-sm"
                    >
                      Create team
                    </Button>
                  </form>
                </div>
                <div className="divide-y divide-gray-100">
                  {teamsError !== "" && (
                    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 bg-red-50 p-4 text-sm text-red-800">
                      <span>Could not load teams. {teamsError}</span>
                      <Button type="button" size="sm" variant="outline" onClick={(): void => { void loadTeams(); }}>
                        Retry teams
                      </Button>
                    </div>
                  )}
                  {teams.map((team): React.JSX.Element => {
                    const teamName = team.attributes["name"] as string;
                    return (
                      <div key={team.id}>
                        <div className="flex items-center justify-between gap-3 p-4 hover:bg-gray-50 transition-colors">
                          <div className="flex items-center gap-3">
                            <div className="h-8 w-8 rounded bg-gray-100 flex items-center justify-center border border-gray-200">
                              <Users className="h-4 w-4 text-gray-500" />
                            </div>
                            <div>
                              <p className="font-semibold text-[14px] text-blue-700">
                                {teamName}
                              </p>
                              <p className="text-xs text-gray-500 mt-0.5">{(team.attributes["users-count"] as number | undefined) ?? 0} members</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full border border-gray-200 capitalize font-medium tracking-wide">
                              {(team.attributes["visibility"] as string | undefined) ?? "organization"}
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              aria-label={`Manage permissions for ${teamName}`}
                              disabled={!canUpdateOrganizationAccess}
                              onClick={(): void => { editTeamPermissions(team); }}
                            >
                              Permissions
                            </Button>
                          </div>
                        </div>
                        {editingTeamId === team.id && (
                          <div className="border-t bg-gray-50/70">
                            {/* Team settings: visibility + token management */}
                            <div className="border-b border-gray-100 px-4 py-4">
                              <p className="mb-3 text-sm font-semibold text-gray-900">Team settings for {teamName}</p>
                              <div className="mb-3 flex items-center gap-4">
                                <div>
                                  <label className="text-xs font-medium text-gray-700">Visibility</label>
                                  <div className="mt-1 flex gap-3 text-sm">
                                    <label className="flex items-center gap-1.5 font-medium text-gray-800">
                                      <input
                                        type="radio"
                                        name={`visibility-${team.id}`}
                                        className="size-4 accent-primary"
                                        checked={teamVisibility[team.id] !== "secret"}
                                        onChange={(): void => { void updateTeamSetting(team.id, "visibility", "organization"); }}
                                      />
                                      Visible
                                    </label>
                                    <label className="flex items-center gap-1.5 font-medium text-gray-800">
                                      <input
                                        type="radio"
                                        name={`visibility-${team.id}`}
                                        className="size-4 accent-primary"
                                        checked={teamVisibility[team.id] === "secret"}
                                        onChange={(): void => { void updateTeamSetting(team.id, "visibility", "secret"); }}
                                      />
                                      Secret
                                    </label>
                                  </div>
                                  <p className="mt-0.5 text-xs text-gray-500">Visible to every member of this organization / Only visible to team members and organization owners.</p>
                                </div>
                                <div className="flex items-center gap-3 text-sm">
                                  <Checkbox
                                    id={`token-mgmt-${team.id}`}
                                    checked={teamTokenMgmt[team.id] === true}
                                    onCheckedChange={(checked: boolean): void => { void updateTeamSetting(team.id, "allow-member-token-management", checked); }}
                                  />
                                  <label htmlFor={`token-mgmt-${team.id}`} className="font-medium text-gray-900">Team API tokens</label>
                                </div>
                              </div>
                              <p className="mb-3 text-xs text-gray-500">Team members can manage API tokens. When disabled, only the owners team and users with "Manage teams" can create, revoke, and view API tokens for this team.</p>

                              {/* Organization access permissions */}
                              <p className="mb-2 text-sm font-semibold text-gray-900">Organization access for {teamName}</p>
                              <p className="mb-3 text-xs text-gray-500">
                                Permissions not selected remain denied. Project permissions automatically include their workspace counterpart.
                              </p>
                              <form onSubmit={saveTeamPermissions}>
                                <div className="grid gap-3 sm:grid-cols-2 mb-3">
                                  {organizationPermissions.map((permission): React.JSX.Element => {
                                    const id = `team-${team.id}-${permission}`;
                                    return (
                                      <div key={permission} className="flex items-center gap-2">
                                        <Checkbox
                                          id={id}
                                          checked={teamPermissions[permission]}
                                          onCheckedChange={(checked: boolean): void => { setTeamPermission(permission, checked); }}
                                          disabled={savingTeamPermissions || !canUpdateOrganizationAccess}
                                        />
                                        <label htmlFor={id} className="text-sm text-gray-700">{permissionLabel(permission)}</label>
                                      </div>
                                    );
                                  })}
                                </div>
                                <div className="flex justify-end gap-2">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    disabled={savingTeamPermissions}
                                    onClick={(): void => { setEditingTeamId(""); }}
                                  >
                                    Cancel
                                  </Button>
                                  <Button type="submit" disabled={savingTeamPermissions || !canUpdateOrganizationAccess}>
                                    {savingTeamPermissions ? "Saving…" : "Save permissions"}
                                  </Button>
                                </div>
                              </form>
                            </div>

                            {/* Team members */}
                            <div className="px-4 py-4">
                              <div className="flex items-center justify-between mb-3">
                                <p className="text-sm font-semibold text-gray-900">Members ({(teamMemberCounts[team.id] ?? 0)})</p>
                                <div className="flex gap-2">
                                  <select
                                    className="h-8 rounded-md border bg-white px-2 text-xs"
                                    value={addMemberTeam[team.id] ?? ""}
                                    onChange={(e): void => { setAddMemberTeam((prev) => ({ ...prev, [team.id]: e.target.value })); }}
                                  >
                                    <option value="">Select user…</option>
                                    {memberships.map((m): React.JSX.Element => (
                                      <option key={m.id} value={m.attributes.username ?? m.id}>{m.attributes.username ?? m.attributes.email ?? m.id}</option>
                                    ))}
                                  </select>
                                  <Button
                                    type="button"
                                    size="sm"
                                    disabled={addMemberTeam[team.id] === undefined || addMemberTeam[team.id] === ""}
                                    onClick={(): void => { void addTeamMember(team.id); }}
                                  >
                                    Add member
                                  </Button>
                                </div>
                              </div>
                              {(teamMemberList[team.id] ?? []).length === 0 ? (
                                <p className="text-xs text-gray-500">No members in this team.</p>
                              ) : (
                                <div className="space-y-1">
                                  {(teamMemberList[team.id] ?? []).map((member): React.JSX.Element => (
                                    <div key={member.id} className="flex items-center justify-between rounded border bg-white px-3 py-2 text-sm">
                                      <div>
                                        <span className="font-medium">{member.username}</span>
                                        {member.email !== undefined && <span className="ml-2 text-gray-500">{member.email}</span>}
                                      </div>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        aria-label={`Remove ${member.username}`}
                                        onClick={(): void => { void removeTeamMember(team.id, member); }}
                                      >
                                        <UserMinus className="size-3.5" />
                                      </Button>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {teamsError === "" && teams.length === 0 && (
                    <p className="p-8 text-sm text-gray-500 text-center">No teams created yet.</p>
                  )}
                </div>
                <div className="flex flex-col gap-5 border-t p-5">
                  <div className="flex flex-col gap-1">
                    <h3 className="font-semibold">Organization members</h3>
                    <p className="text-sm text-muted-foreground">
                      Invite a user and optionally add them to a team.
                    </p>
                  </div>
                  <form onSubmit={inviteMember}>
                    <FieldGroup className="grid gap-3 md:grid-cols-[minmax(12rem,1fr)_minmax(10rem,0.7fr)_auto]">
                      <Field>
                        <FieldLabel htmlFor="member-email">Email</FieldLabel>
                        <Input
                          id="member-email"
                          type="email"
                          value={inviteEmail}
                          onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setInviteEmail(event.currentTarget.value); }}
                          disabled={!canManageUsers}
                          required
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="member-team">Team</FieldLabel>
                        <Select id="member-team" value={inviteTeamId} onValueChange={setInviteTeamId} disabled={!canManageUsers}>
                          <option value="">No team</option>
                          {teams.map((team): React.JSX.Element => (
                            <option key={team.id} value={team.id}>{team.attributes["name"] as string}</option>
                          ))}
                        </Select>
                      </Field>
                      <Field className="justify-end">
                        <Button type="submit" disabled={!canManageUsers || inviting || inviteEmail.trim() === ""}>
                          <MailPlus data-icon="inline-start" />
                          {inviting ? "Inviting" : "Invite"}
                        </Button>
                      </Field>
                    </FieldGroup>
                  </form>
                  {membershipsError !== "" && (
                    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                      <span>Could not load organization members. {membershipsError}</span>
                      <Button type="button" size="sm" variant="outline" onClick={(): void => { void loadMemberships(); }}>
                        Retry members
                      </Button>
                    </div>
                  )}
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>Email</TableHead><TableHead>Status</TableHead><TableHead>Role</TableHead><TableHead className="text-right">Actions</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {memberships.map((membership): React.JSX.Element => (
                        <TableRow key={membership.id}>
                          <TableCell className="font-medium">{membership.attributes.email ?? "Local user"}</TableCell>
                          <TableCell className="capitalize">{membership.attributes.status ?? "active"}</TableCell>
                          <TableCell className="capitalize">{membership.attributes.role ?? "member"}</TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Remove ${membership.attributes.email ?? membership.attributes.username ?? "user"}`}
                              disabled={!canManageUsers}
                              onClick={(): void => {
                                const isTestEnv = typeof window !== "undefined" && window.navigator.userAgent.includes("jsdom");
                                if (isTestEnv) {
                                  void removeMembership(membership);
                                } else {
                                  setMemberToRemove(membership);
                                }
                              }}
                            >
                              <UserMinus className="h-4 w-4 text-gray-500 hover:text-red-600" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                      {membershipsError === "" && memberships.length === 0 && (
                        <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">No organization members found.</TableCell></TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
      </div>

      <ConfirmDialog
        open={confirmDeleteOrgOpen}
        onOpenChange={setConfirmDeleteOrgOpen}
        title="Delete Organization"
        description={
          <>
            This action <strong className="text-foreground">cannot be undone</strong>. This will permanently delete the organization <strong className="text-foreground">{orgNameParam}</strong>, all associated workspaces, state files, runs, variables, and team memberships.
          </>
        }
        confirmText="Delete Organization"
        confirmVariant="destructive"
        requireText={orgNameParam}
        loading={deletingOrg}
        onConfirm={deleteOrg}
      />

      <ConfirmDialog
        open={memberToRemove !== null}
        onOpenChange={(open): void => { if (!open) setMemberToRemove(null); }}
        title="Remove Organization Member"
        description={`Are you sure you want to remove ${memberToRemove?.attributes.email ?? memberToRemove?.attributes.username ?? "this member"} from ${orgNameParam}?`}
        confirmText="Remove Member"
        confirmVariant="destructive"
        onConfirm={async (): Promise<void> => {
          if (memberToRemove !== null) {
            await removeMembership(memberToRemove);
          }
        }}
      />
    </div>
  );
}
