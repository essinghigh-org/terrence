import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Settings, Users, Trash2, HelpCircle } from "lucide-react";

export function OrganizationSettings(): React.JSX.Element {
  const { orgName } = useParams<{ orgName: string }>();
  const navigate = useNavigate();
  const orgNameParam = orgName ?? "";
  const [org, setOrg] = useState<{ id: string; attributes: Record<string, unknown> } | null>(null);
  const [name, setName] = useState("");
  const [defaultIacBinary, setDefaultIacBinary] = useState("tofu");
  const [defaultTerraformVersion, setDefaultTerraformVersion] = useState("latest");
  const [saving, setSaving] = useState(false);
  const [teams, setTeams] = useState<{ id: string; attributes: Record<string, unknown> }[]>([]);
  const [newTeamName, setNewTeamName] = useState("");
  const [activeTab, setActiveTab] = useState("general");

  useEffect((): void => {
    void loadOrg();
    void loadTeams();
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
      const res = await fetchApi(`/api/v2/organizations/${orgNameParam}/teams`) as { data: { id: string; attributes: Record<string, unknown> }[] };
      setTeams(res.data);
    } catch {
      setTeams([]);
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
      alert("Organization settings saved");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to save settings";
      alert(msg);
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
      alert(msg);
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
      void loadTeams();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create team";
      alert(msg);
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
                  {teams.map((team: { id: string; attributes: Record<string, unknown> }): React.JSX.Element => (
                    <div key={team.id} className="flex items-center justify-between p-4 hover:bg-gray-50 transition-colors">
                      <div className="flex items-center gap-3">
                         <div className="h-8 w-8 rounded bg-gray-100 flex items-center justify-center border border-gray-200">
                            <Users className="h-4 w-4 text-gray-500" />
                         </div>
                        <div>
                          <p className="font-semibold text-[14px] text-blue-700 hover:underline cursor-pointer">
                            {(team.attributes["name"] as string)}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">{(team.attributes["users-count"] as number | undefined) ?? 0} members</p>
                        </div>
                      </div>
                      <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full border border-gray-200 capitalize font-medium tracking-wide">
                        {(team.attributes["visibility"] as string | undefined) ?? "organization"}
                      </span>
                    </div>
                  ))}
                  {teams.length === 0 && (
                    <p className="p-8 text-sm text-gray-500 text-center">No teams created yet.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
