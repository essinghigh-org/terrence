import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Field, FieldGroup, FieldLabel } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { Checkbox } from "../components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { toast } from "../components/ui/toast";
import { HelpCircle, MailPlus, Settings, Trash2, UserMinus, Users } from "lucide-react";

type Team = Readonly<{ id: string; attributes: Readonly<Record<string, unknown>> }>;
type Membership = Readonly<{
  id: string;
  attributes: Readonly<{ email?: string | null; role?: string; status?: string }>;
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
  const orgNameParam = orgName ?? "";
  const [org, setOrg] = useState<{ id: string; attributes: Record<string, unknown> } | null>(null);
  const [name, setName] = useState("");
  const [defaultIacBinary, setDefaultIacBinary] = useState("tofu");
  const [defaultTerraformVersion, setDefaultTerraformVersion] = useState("latest");
  const [saving, setSaving] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [newTeamName, setNewTeamName] = useState("");
  const [editingTeamId, setEditingTeamId] = useState("");
  const [teamPermissions, setTeamPermissions] = useState<Record<OrganizationPermission, boolean>>(
    (): Record<OrganizationPermission, boolean> =>
      Object.fromEntries(organizationPermissions.map((permission): [OrganizationPermission, boolean] => [permission, false])) as Record<OrganizationPermission, boolean>,
  );
  const [savingTeamPermissions, setSavingTeamPermissions] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteTeamId, setInviteTeamId] = useState("");
  const [inviting, setInviting] = useState(false);
  const [activeTab, setActiveTab] = useState("general");

  useEffect((): void => {
    void loadOrg();
    void loadTeams();
    void loadMemberships();
  }, [orgName]);

  const loadOrg = async (): Promise<void> => {
    try {
      const res = await fetchApi(`/api/v2/organizations/${orgName ?? ""}`) as { data: { id: string; attributes: Record<string, unknown> } };
      setOrg(res.data);
      setName(res.data.attributes["name"] as string);
      setDefaultIacBinary((res.data.attributes["default-iac-binary"] as string | undefined) ?? "tofu");
      setDefaultTerraformVersion((res.data.attributes["default-terraform-version"] as string | undefined) ?? "latest");
    } catch (err: unknown) {
      console.error("Failed to load organization", err);
    }
  };

  const loadTeams = async (): Promise<void> => {
    try {
      const res = await fetchApi(`/api/v2/organizations/${orgNameParam}/teams`) as { data?: Team[] };
      setTeams(Array.isArray(res.data) ? res.data : []);
    } catch {
      setTeams([]);
    }
  };

  const loadMemberships = async (): Promise<void> => {
    try {
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(orgNameParam)}/organization-memberships`,
      ) as { data?: Membership[] };
      setMemberships(Array.isArray(response.data) ? response.data : []);
    } catch {
      setMemberships([]);
    }
  };

  const saveSettings = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetchApi(`/api/v2/organizations/${orgNameParam}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            attributes: {
              name,
              "default-iac-binary": defaultIacBinary,
              "default-terraform-version": defaultTerraformVersion,
            },
          },
        }),
      }) as { data: { id: string; attributes: Record<string, unknown> } };
      setOrg(res.data);
      if (name !== orgNameParam) {
        void navigate(`/app/${name}/settings`);
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
    if (!confirm(`Are you sure you want to delete organization "${orgName ?? ""}"? This will remove all workspaces, runs, and data.`)) return;
    try {
      await fetchApi(`/api/v2/organizations/${orgNameParam}`, { method: "DELETE" });
      void navigate("/app");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete organization";
      toast.add({ title: "Could not delete organization", description: msg, type: "error" });
    }
  };

  const createTeam = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (newTeamName.trim() === "") return;
    try {
      await fetchApi(`/api/v2/organizations/${orgNameParam}/teams`, {
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
    setEditingTeamId(team.id);
    setTeamPermissions(teamOrganizationAccess(team));
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

  const inviteMember = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
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
    if (!window.confirm(`Remove ${membership.attributes.email ?? "this member"} from the organization?`)) return;
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
    }
  };

  if (org == null) {
    return <div className="p-8 text-center text-gray-500">Loading organization settings...</div>;
  }

  return (
    <div className="max-w-4xl w-full">
      {/* Breadcrumb */}
      <div className="text-xs text-gray-500 mb-2 flex items-center gap-1.5 font-medium">
        <Link to={`/app`} className="hover:underline">Dashboard</Link>
        <span className="text-gray-300">/</span>
        <Link to={"/app/" + (orgNameParam)} className="hover:underline">{orgName}</Link>
        <span className="text-gray-300">/</span>
        <span className="text-gray-900">Settings</span>
      </div>

      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Organization Settings</h1>
      </div>

      <div className="flex flex-col md:flex-row gap-8">
        <aside className="w-full md:w-56 flex-shrink-0">
          <nav className="flex flex-col gap-1">
            <button
              onClick={(): void => { setActiveTab("general"); }}
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                activeTab === "general" ? "bg-[#e0eaff] text-blue-700" : "text-gray-700 hover:bg-gray-100"
              }`}
            >
              <Settings className="w-4 h-4 mr-2" /> General
            </button>

            <button
              onClick={(): void => { setActiveTab("teams"); }}
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                activeTab === "teams" ? "bg-[#e0eaff] text-blue-700" : "text-gray-700 hover:bg-gray-100"
              }`}
            >
              <Users className="w-4 h-4 mr-2" /> Teams
            </button>

            <Link
              to={"/app/" + (orgNameParam) + "/variable-sets"}
              className="flex items-center px-3 py-2 text-sm font-medium rounded-md text-gray-700 hover:bg-gray-100 transition-colors"
            >
              Variable Sets
            </Link>

            <Link
              to={"/app/" + (orgNameParam) + "/settings/vcs"}
              className="flex items-center px-3 py-2 text-sm font-medium rounded-md text-gray-700 hover:bg-gray-100 transition-colors"
            >
              VCS Providers
            </Link>

            <Link
              to={"/app/" + (orgNameParam) + "/settings/agents"}
              className="flex items-center px-3 py-2 text-sm font-medium rounded-md text-gray-700 hover:bg-gray-100 transition-colors"
            >
              Agent Pools
            </Link>
          </nav>
        </aside>

        <div className="flex-1 space-y-6">
          {activeTab === "general" && (
            <>
              <Card className="border-gray-200 shadow-sm rounded-md">
                <CardHeader className="border-b border-gray-100 bg-gray-50/50 py-4 px-5">
                  <CardTitle className="text-base font-semibold text-gray-900">General settings</CardTitle>
                </CardHeader>
                <CardContent className="p-5">
                  <form onSubmit={saveSettings} className="space-y-6 max-w-lg">
                    <div className="space-y-1.5">
                      <label htmlFor="org-name" className="text-sm font-semibold text-gray-900">Organization Name</label>
                      <Input
                        id="org-name"
                        value={name}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setName(event.target.value); }}
                        required
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="org-iac" className="text-sm font-semibold text-gray-900 flex items-center gap-1">
                        Default IaC Binary
                        <HelpCircle className="h-3.5 w-3.5 text-gray-400" />
                      </label>
                      <select
                        id="org-iac"
                        className="flex h-9 w-full rounded-md border border-gray-300 bg-white px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                        value={defaultIacBinary}
                        onChange={(event: React.ChangeEvent<HTMLSelectElement>): void => { setDefaultIacBinary(event.target.value); }}
                      >
                        <option value="tofu">OpenTofu (tofu)</option>
                        <option value="terraform">Terraform (terraform)</option>
                      </select>
                      <p className="text-[13px] text-gray-500 mt-1">The engine used by default for new workspaces.</p>
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="org-version" className="text-sm font-semibold text-gray-900 flex items-center gap-1">
                        Default Version Constraint
                        <HelpCircle className="h-3.5 w-3.5 text-gray-400" />
                      </label>
                      <Input
                        id="org-version"
                        value={defaultTerraformVersion}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setDefaultTerraformVersion(event.target.value); }}
                        placeholder="latest"
                        className="h-9"
                      />
                    </div>
                    <Button type="submit" disabled={saving} className="bg-[#2962ff] hover:bg-[#1a4bcf] h-9">
                      {saving ? "Saving..." : "Save settings"}
                    </Button>
                  </form>
                </CardContent>
              </Card>

              {/* Danger Zone */}
              <Card className="border-red-200 shadow-sm rounded-md overflow-hidden">
                <CardHeader className="bg-red-50/50 py-4 px-5 border-b border-red-100">
                  <CardTitle className="text-base font-semibold text-red-800">Danger Zone</CardTitle>
                </CardHeader>
                <CardContent className="p-5">
                  <p className="text-sm text-gray-700 mb-4">
                    Deleting this organization will permanently remove all workspaces, runs, state versions, variables, and configurations. This action cannot be undone.
                  </p>
                  <Button variant="outline" onClick={deleteOrg} className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 h-9">
                    <Trash2 className="w-4 h-4 mr-2" /> Delete Organization
                  </Button>
                </CardContent>
              </Card>
            </>
          )}

          {activeTab === "teams" && (
            <Card className="border-gray-200 shadow-sm rounded-md">
              <CardHeader className="border-b border-gray-100 bg-gray-50/50 py-4 px-5">
                <CardTitle className="text-base font-semibold text-gray-900">Teams</CardTitle>
                <CardDescription className="text-[13px]">Manage access across the organization.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="p-5 border-b border-gray-100">
                  <form onSubmit={createTeam} className="flex gap-2 max-w-md">
                    <Input
                      placeholder="New team name"
                      value={newTeamName}
                      onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setNewTeamName(event.target.value); }}
                      className="h-9"
                    />
                    <Button type="submit" className="bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 h-9 shadow-sm">
                      Create team
                    </Button>
                  </form>
                </div>
                <div className="divide-y divide-gray-100">
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
                              onClick={(): void => { editTeamPermissions(team); }}
                            >
                              Permissions
                            </Button>
                          </div>
                        </div>
                        {editingTeamId === team.id && (
                          <form onSubmit={saveTeamPermissions} className="border-t bg-gray-50/70 p-4">
                            <div className="mb-3">
                              <p className="text-sm font-semibold text-gray-900">Organization access for {teamName}</p>
                              <p className="text-xs text-gray-500">
                                Permissions not selected remain denied. Project permissions automatically include their workspace counterpart.
                              </p>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2">
                              {organizationPermissions.map((permission): React.JSX.Element => {
                                const id = `team-${team.id}-${permission}`;
                                return (
                                  <div key={permission} className="flex items-center gap-2">
                                    <Checkbox
                                      id={id}
                                      checked={teamPermissions[permission]}
                                      onCheckedChange={(checked: boolean): void => { setTeamPermission(permission, checked); }}
                                      disabled={savingTeamPermissions}
                                    />
                                    <label htmlFor={id} className="text-sm text-gray-700">{permissionLabel(permission)}</label>
                                  </div>
                                );
                              })}
                            </div>
                            <div className="mt-4 flex justify-end gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                disabled={savingTeamPermissions}
                                onClick={(): void => { setEditingTeamId(""); }}
                              >
                                Cancel
                              </Button>
                              <Button type="submit" disabled={savingTeamPermissions}>
                                {savingTeamPermissions ? "Saving…" : "Save permissions"}
                              </Button>
                            </div>
                          </form>
                        )}
                      </div>
                    );
                  })}
                  {teams.length === 0 && (
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
                          required
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="member-team">Team</FieldLabel>
                        <Select id="member-team" value={inviteTeamId} onValueChange={setInviteTeamId}>
                          <option value="">No team</option>
                          {teams.map((team): React.JSX.Element => (
                            <option key={team.id} value={team.id}>{team.attributes["name"] as string}</option>
                          ))}
                        </Select>
                      </Field>
                      <Field className="justify-end">
                        <Button type="submit" disabled={inviting || inviteEmail.trim() === ""}>
                          <MailPlus data-icon="inline-start" />
                          {inviting ? "Inviting" : "Invite"}
                        </Button>
                      </Field>
                    </FieldGroup>
                  </form>
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
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove ${membership.attributes.email ?? "member"}`}
                              disabled={membership.attributes.role === "owner"}
                              onClick={(): void => { void removeMembership(membership); }}
                            >
                              <UserMinus />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                      {memberships.length === 0 && (
                        <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">No organization members found.</TableCell></TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
