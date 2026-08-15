import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Select, SelectItem } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchApi } from "@/lib/api";

type AccessLevel = "read" | "plan" | "write" | "admin" | "custom";

type Team = {
  id: string;
  attributes: { name: string };
};

type CustomPermissions = {
  runs: "read" | "plan" | "apply";
  variables: "none" | "read" | "write";
  "state-versions": "none" | "read-outputs" | "read" | "write";
  "sentinel-mocks": "none" | "read";
  "workspace-locking": boolean;
  "run-tasks": boolean;
  "policy-overrides": boolean;
};

type TeamWorkspace = {
  id: string;
  attributes: {
    access: AccessLevel;
    permissions?: Partial<CustomPermissions> | null;
  };
  relationships: {
    team: { data: { id: string; type: string } };
    workspace: { data: { id: string; type: string } };
  };
};

const defaultPermissions: CustomPermissions = {
  runs: "read",
  variables: "none",
  "state-versions": "none",
  "sentinel-mocks": "none",
  "workspace-locking": false,
  "run-tasks": false,
  "policy-overrides": false,
};

const messageFrom = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export function WorkspaceTeamAccess({
  orgName,
  workspaceId,
}: Readonly<{
  orgName: string;
  workspaceId: string;
}>): React.JSX.Element {
  const [teams, setTeams] = useState<Team[]>([]);
  const [relationships, setRelationships] = useState<TeamWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<TeamWorkspace | null>(null);
  const [teamId, setTeamId] = useState("");
  const [access, setAccess] = useState<AccessLevel>("read");
  const [permissions, setPermissions] = useState<CustomPermissions>(defaultPermissions);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState("");

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setPageError("");
    Promise.all([
      fetchApi(`/organizations/${encodeURIComponent(orgName)}/teams`),
      fetchApi(`/team-workspaces?filter%5Bworkspace%5D%5Bid%5D=${encodeURIComponent(workspaceId)}`),
    ])
      .then(([teamResponse, accessResponse]: unknown[]): void => {
        if (!active) return;
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const teamData = (teamResponse as { data?: Team[] }).data;
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const accessData = (accessResponse as { data?: TeamWorkspace[] }).data;
        setTeams(Array.isArray(teamData) ? teamData : []);
        setRelationships(Array.isArray(accessData) ? accessData : []);
      })
      .catch((error: unknown): void => {
        if (active) setPageError(messageFrom(error, "Failed to load team access"));
      })
      .finally((): void => {
        if (active) setLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, [orgName, workspaceId]);

  const assignedTeamIds = useMemo(
    (): Set<string> => new Set(
      relationships.map((relationship: TeamWorkspace): string => relationship.relationships.team.data.id),
    ),
    [relationships],
  );
  const availableTeams = teams.filter((team: Team): boolean => !assignedTeamIds.has(team.id));
  const namesById = useMemo(
    (): Map<string, string> => new Map(
      teams.map((team: Team): [string, string] => [team.id, team.attributes.name]),
    ),
    [teams],
  );

  const openEditor = (relationship?: TeamWorkspace): void => {
    setEditing(relationship ?? null);
    setTeamId(relationship?.relationships.team.data.id ?? "");
    setAccess(relationship?.attributes.access ?? "read");
    setPermissions({
      ...defaultPermissions,
      ...(relationship?.attributes.permissions ?? {}),
    });
    setEditorError("");
    setEditorOpen(true);
  };

  const setPermission = <K extends keyof CustomPermissions>(
    key: K,
    value: CustomPermissions[K],
  ): void => {
    setPermissions((current: CustomPermissions): CustomPermissions => ({ ...current, [key]: value }));
  };

  const saveAccess = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (teamId === "") {
      setEditorError("Select a team.");
      return;
    }
    const attributes = {
      access,
      ...(access === "custom" ? { permissions } : undefined),
    };
    setSaving(true);
    setEditorError("");
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi(
        editing == null ? "/team-workspaces" : `/team-workspaces/${editing.id}`,
        {
          method: editing == null ? "POST" : "PATCH",
          body: JSON.stringify({
            data: {
              type: "team-workspaces",
              ...(editing == null ? undefined : { id: editing.id }),
              attributes,
              ...(editing == null
                ? {
                    relationships: {
                      team: { data: { id: teamId, type: "teams" } },
                      workspace: { data: { id: workspaceId, type: "workspaces" } },
                    },
                  }
                : undefined),
            },
          }),
        },
      ) as { data: TeamWorkspace };
      const saved = response.data;
      setRelationships((current: TeamWorkspace[]): TeamWorkspace[] =>
        editing == null
          ? [...current, saved]
          : current.map((relationship: TeamWorkspace): TeamWorkspace =>
              relationship.id === saved.id ? saved : relationship,
            ),
      );
      setEditorOpen(false);
    } catch (error: unknown) {
      setEditorError(messageFrom(error, "Failed to save team access"));
    } finally {
      setSaving(false);
    }
  };

  const removeAccess = async (relationship: TeamWorkspace): Promise<void> => {
    setPageError("");
    try {
      await fetchApi(`/team-workspaces/${relationship.id}`, { method: "DELETE" });
      setRelationships((current: TeamWorkspace[]): TeamWorkspace[] =>
        current.filter((item: TeamWorkspace): boolean => item.id !== relationship.id),
      );
    } catch (error: unknown) {
      setPageError(messageFrom(error, "Failed to remove team access"));
    }
  };

  return (
    <>
      <Card className="max-w-4xl">
        <CardHeader>
          <CardTitle>Team access</CardTitle>
          <CardDescription>
            Grant organization teams read, plan, write, admin, or custom permissions for this workspace.
          </CardDescription>
          <CardAction>
            <Button
              onClick={(): void => { openEditor(); }}
              disabled={availableTeams.length === 0}
            >
              <Plus data-icon="inline-start" />
              Add team
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {pageError !== "" && <p role="alert" className="text-sm text-destructive">{pageError}</p>}
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Team</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && (
                  <TableRow>
                    <TableCell colSpan={3} className="h-20 text-center text-muted-foreground">
                      Loading team access…
                    </TableCell>
                  </TableRow>
                )}
                {!loading && relationships.map((relationship: TeamWorkspace): React.JSX.Element => (
                  <TableRow key={relationship.id}>
                    <TableCell className="font-medium">
                      {namesById.get(relationship.relationships.team.data.id) ?? relationship.relationships.team.data.id}
                    </TableCell>
                    <TableCell><Badge variant="outline">{relationship.attributes.access}</Badge></TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={(): void => { openEditor(relationship); }}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={(): void => { void removeAccess(relationship); }}
                        >
                          Remove
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {!loading && relationships.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="h-20 text-center text-muted-foreground">
                      No teams have explicit access to this workspace.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing == null ? "Add team access" : "Edit team access"}</DialogTitle>
            <DialogDescription>
              Select an access level or configure individual workspace permissions.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveAccess} noValidate>
            <FieldGroup>
              <Field data-disabled={editing != null} data-invalid={editorError !== "" && teamId === ""}>
                <FieldLabel htmlFor="team-access-team">Team</FieldLabel>
                <Select
                  id="team-access-team"
                  value={teamId}
                  onValueChange={setTeamId}
                  disabled={editing != null}
                  aria-invalid={editorError !== "" && teamId === ""}
                >
                  <SelectItem value="">Select a team</SelectItem>
                  {(editing == null ? availableTeams : teams).map((team: Team): React.JSX.Element => (
                    <SelectItem key={team.id} value={team.id}>{team.attributes.name}</SelectItem>
                  ))}
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="team-access-level">Access level</FieldLabel>
                <Select
                  id="team-access-level"
                  value={access}
// SAFETY: the select options are generated from the same union; the change event carries one of them.
                  onValueChange={(value: string): void => {

                    // SAFETY: the change event carries one of the union values the UI renders from the same options.

                    setAccess(value as AccessLevel);

                  }}
                >
                  <SelectItem value="read">Read</SelectItem>
                  <SelectItem value="plan">Plan</SelectItem>
                  <SelectItem value="write">Write</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </Select>
              </Field>
              {access === "custom" && (
                <FieldSet>
                  <FieldLegend>Custom permissions</FieldLegend>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="team-access-runs">Runs</FieldLabel>
                      <Select
                        id="team-access-runs"
                        value={permissions.runs}
                        onValueChange={(value: string): void => {
// SAFETY: the value matches the fixture's declared contract.
                          setPermission("runs", value as CustomPermissions["runs"]);
                        }}
                      >
                        <SelectItem value="read">Read</SelectItem>
                        <SelectItem value="plan">Plan</SelectItem>
                        <SelectItem value="apply">Apply</SelectItem>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="team-access-variables">Variables</FieldLabel>
                      <Select
                        id="team-access-variables"
                        value={permissions.variables}
                        onValueChange={(value: string): void => {
// SAFETY: the value matches the fixture's declared contract.
                          setPermission("variables", value as CustomPermissions["variables"]);
                        }}
                      >
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="read">Read</SelectItem>
                        <SelectItem value="write">Write</SelectItem>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="team-access-state">State versions</FieldLabel>
                      <Select
                        id="team-access-state"
                        value={permissions["state-versions"]}
                        onValueChange={(value: string): void => {
// SAFETY: the value matches the fixture's declared contract.
                          setPermission("state-versions", value as CustomPermissions["state-versions"]);
                        }}
                      >
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="read-outputs">Read outputs</SelectItem>
                        <SelectItem value="read">Read</SelectItem>
                        <SelectItem value="write">Write</SelectItem>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="team-access-mocks">Sentinel mocks</FieldLabel>
                      <Select
                        id="team-access-mocks"
                        value={permissions["sentinel-mocks"]}
                        onValueChange={(value: string): void => {
// SAFETY: the value matches the fixture's declared contract.
                          setPermission("sentinel-mocks", value as CustomPermissions["sentinel-mocks"]);
                        }}
                      >
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="read">Read</SelectItem>
                      </Select>
                    </Field>
                    <Field orientation="horizontal">
                      <Checkbox
                        id="team-access-locking"
                        checked={permissions["workspace-locking"]}
                        onCheckedChange={(checked: boolean): void => {
                          setPermission("workspace-locking", checked);
                        }}
                      />
                      <FieldContent>
                        <FieldLabel htmlFor="team-access-locking">Workspace locking</FieldLabel>
                        <FieldDescription>Allow manual lock and unlock actions.</FieldDescription>
                      </FieldContent>
                    </Field>
                    <Field orientation="horizontal">
                      <Checkbox
                        id="team-access-run-tasks"
                        checked={permissions["run-tasks"]}
                        onCheckedChange={(checked: boolean): void => {
                          setPermission("run-tasks", checked);
                        }}
                      />
                      <FieldLabel htmlFor="team-access-run-tasks">Manage run tasks</FieldLabel>
                    </Field>
                    <Field orientation="horizontal">
                      <Checkbox
                        id="team-access-policy-overrides"
                        checked={permissions["policy-overrides"]}
                        onCheckedChange={(checked: boolean): void => {
                          setPermission("policy-overrides", checked);
                        }}
                      />
                      <FieldLabel htmlFor="team-access-policy-overrides">Override policy checks</FieldLabel>
                    </Field>
                  </FieldGroup>
                </FieldSet>
              )}
              <FieldError>{editorError}</FieldError>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={(): void => { setEditorOpen(false); }}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving && <Spinner data-icon="inline-start" />}
                  {saving ? "Saving" : "Save team access"}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
