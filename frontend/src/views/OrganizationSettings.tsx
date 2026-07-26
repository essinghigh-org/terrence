import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { fetchApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function OrganizationSettings() {
  const { orgName } = useParams();
  const navigate = useNavigate();
  const [org, setOrg] = useState<any>(null);
  const [name, setName] = useState("");
  const [defaultIacBinary, setDefaultIacBinary] = useState("tofu");
  const [defaultTerraformVersion, setDefaultTerraformVersion] = useState("latest");
  const [saving, setSaving] = useState(false);
  const [teams, setTeams] = useState<any[]>([]);
  const [newTeamName, setNewTeamName] = useState("");

  useEffect(() => {
    loadOrg();
    loadTeams();
  }, [orgName]);

  const loadOrg = async () => {
    try {
      const res = await fetchApi(`/organizations/${orgName}`);
      setOrg(res.data);
      setName(res.data.attributes.name);
      setDefaultIacBinary(res.data.attributes["default-iac-binary"] || "tofu");
      setDefaultTerraformVersion(res.data.attributes["default-terraform-version"] || "latest");
    } catch (err: any) {
      console.error("Failed to load organization", err);
    }
  };

  const loadTeams = async () => {
    try {
      const res = await fetchApi(`/organizations/${orgName}/teams`);
      setTeams(res.data || []);
    } catch {
      setTeams([]);
    }
  };

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetchApi(`/organizations/${orgName}`, {
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
      });
      setOrg(res.data);
      if (name !== orgName) {
        navigate(`/app/${name}/settings`);
      }
      alert("Organization settings saved");
    } catch (err: any) {
      alert(err.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const deleteOrg = async () => {
    if (!confirm(`Are you sure you want to delete organization "${orgName}"? This will remove all workspaces, runs, and data.`)) return;
    try {
      await fetchApi(`/organizations/${orgName}`, { method: "DELETE" });
      navigate("/app");
    } catch (err: any) {
      alert(err.message || "Failed to delete organization");
    }
  };

  const createTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTeamName.trim()) return;
    try {
      await fetchApi(`/organizations/${orgName}/teams`, {
        method: "POST",
        body: JSON.stringify({
          data: { attributes: { name: newTeamName.trim() } },
        }),
      });
      setNewTeamName("");
      loadTeams();
    } catch (err: any) {
      alert(err.message || "Failed to create team");
    }
  };

  if (!org) {
    return <div className="p-8 text-center text-gray-500">Loading organization settings...</div>;
  }

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8">
      {/* Breadcrumb */}
      <div className="text-sm text-gray-500 flex items-center gap-1.5">
        <Link to="/app" className="hover:underline">Dashboard</Link> /
        <Link to={`/app/${orgName}`} className="hover:underline">{orgName}</Link> /
        <span>Settings</span>
      </div>

      <h1 className="text-3xl font-bold">Organization Settings</h1>

      {/* General Settings */}
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveSettings} className="space-y-4 max-w-lg">
            <div className="space-y-2">
              <label htmlFor="org-name" className="text-sm font-medium">Organization Name</label>
              <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <label htmlFor="org-iac" className="text-sm font-medium">Default IaC Binary</label>
              <select
                id="org-iac"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                value={defaultIacBinary}
                onChange={(e) => setDefaultIacBinary(e.target.value)}
              >
                <option value="tofu">OpenTofu (tofu)</option>
                <option value="terraform">Terraform (terraform)</option>
              </select>
            </div>
            <div className="space-y-2">
              <label htmlFor="org-version" className="text-sm font-medium">Default Terraform Version</label>
              <Input id="org-version" value={defaultTerraformVersion} onChange={(e) => setDefaultTerraformVersion(e.target.value)} placeholder="latest" />
            </div>
            <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save Settings"}</Button>
          </form>
        </CardContent>
      </Card>

      {/* Teams */}
      <Card>
        <CardHeader>
          <CardTitle>Teams</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={createTeam} className="flex gap-2 max-w-md">
            <Input
              placeholder="New team name"
              value={newTeamName}
              onChange={(e) => setNewTeamName(e.target.value)}
            />
            <Button type="submit">Create Team</Button>
          </form>
          <div className="border rounded-md divide-y">
            {teams.map((team: any) => (
              <div key={team.id} className="flex items-center justify-between p-3">
                <div>
                  <p className="font-medium">{team.attributes?.name}</p>
                  <p className="text-xs text-gray-500">{team.attributes?.["users-count"] || 0} members</p>
                </div>
                <span className="text-xs text-gray-400 capitalize">{team.attributes?.visibility || "organization"}</span>
              </div>
            ))}
            {teams.length === 0 && (
              <p className="p-4 text-sm text-gray-500 text-center">No teams yet.</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Danger Zone */}
      <Card className="border-rose-200">
        <CardHeader>
          <CardTitle className="text-rose-800">Danger Zone</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-rose-700 mb-4">
            Deleting this organization will permanently remove all workspaces, runs, state versions, variables, and configurations.
          </p>
          <Button variant="destructive" onClick={deleteOrg}>Delete Organization</Button>
        </CardContent>
      </Card>
    </div>
  );
}
