import { useCallback, useEffect, useMemo, useState } from "react";
import type { JsonValue } from "../lib/json";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
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
import { formatDate } from "@/lib/utils";

const messageFrom = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

type SshKey = {
  id: string;
  attributes: { name: string };
};

export function WorkspaceSshKey({
  orgName,
  workspaceId,
  initialSshKeyId,
}: Readonly<{
  orgName: string;
  workspaceId: string;
  initialSshKeyId: string | null;
}>): React.JSX.Element {
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState(initialSshKeyId ?? "");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setError("");
    fetchApi<{ data?: SshKey[] }>(`/organizations/${encodeURIComponent(orgName)}/ssh-keys`)
      .then((response): void => {
        if (!active) return;
        const data = response.data;
        setKeys(Array.isArray(data) ? data : []);
      })
      .catch((caught: unknown): void => {
        if (active) setError(messageFrom(caught, "Failed to load SSH keys"));
      })
      .finally((): void => {
        if (active) setLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, [orgName]);

  const saveAssignment = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await fetchApi(`/workspaces/${workspaceId}/relationships/ssh-key`, {
        method: "PATCH",
        body: JSON.stringify({
          data: selectedKeyId === "" ? null : { id: selectedKeyId, type: "ssh-keys" },
        }),
      });
      setSaved(true);
    } catch (caught: unknown) {
      setError(messageFrom(caught, "Failed to update SSH key"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={saveAssignment} className="mx-auto max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>SSH key</CardTitle>
          <CardDescription>
            Assign an organization SSH key for private Git module sources used by this workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-disabled={loading}>
              <FieldLabel htmlFor="workspace-ssh-key">Assigned key</FieldLabel>
              <Select
                id="workspace-ssh-key"
                value={selectedKeyId}
                onValueChange={setSelectedKeyId}
                disabled={loading}
              >
                <SelectItem value="">No SSH key</SelectItem>
                {keys.map((key: SshKey): React.JSX.Element => (
                  <SelectItem key={key.id} value={key.id}>{key.attributes.name}</SelectItem>
                ))}
              </Select>
              <FieldDescription>
                Private key material remains write-only and is never displayed here.
              </FieldDescription>
            </Field>
            <FieldError>{error}</FieldError>
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-between">
          <span role="status" className="text-sm text-muted-foreground">
            {saved ? "SSH key assignment saved." : keys.length === 0 && !loading ? "No organization SSH keys are available." : ""}
          </span>
          <Button type="submit" disabled={loading || saving}>
            {saving && <Spinner data-icon="inline-start" />}
            {saving ? "Saving…" : "Save assignment"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

type WorkspaceSummary = {
  id: string;
  attributes: { name: string };
};

type RunTrigger = {
  id: string;
  attributes: { "created-at"?: string };
  relationships: {
    "sourceable-workspace": { data: { id: string; type: string } };
  };
};

export function WorkspaceRunTriggers({
  orgName,
  workspaceId,
}: Readonly<{
  orgName: string;
  workspaceId: string;
}>): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [triggers, setTriggers] = useState<RunTrigger[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (): Promise<void> => {
    // SAFETY: both endpoints return the JSON:API envelope per contract.
    const [workspaceResponse, triggerResponse] = await Promise.all([
      fetchApi(`/organizations/${encodeURIComponent(orgName)}/workspaces?page[size]=100`),
      fetchApi(`/workspaces/${workspaceId}/run-triggers`),
    ]) as [{ data?: WorkspaceSummary[] }, { data?: RunTrigger[] }];
    setWorkspaces(Array.isArray(workspaceResponse.data) ? workspaceResponse.data : []);
    setTriggers(Array.isArray(triggerResponse.data) ? triggerResponse.data : []);
  }, [orgName, workspaceId]);

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setError("");
    load()
      .catch((caught: unknown): void => {
        if (active) setError(messageFrom(caught, "Failed to load run triggers"));
      })
      .finally((): void => {
        if (active) setLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, [load]);

  const attachedIds = useMemo(
    (): Set<string> => new Set(
      triggers.map((trigger: RunTrigger): string =>
        trigger.relationships["sourceable-workspace"].data.id,
      ),
    ),
    [triggers],
  );
  const availableWorkspaces = workspaces.filter(
    (workspace: WorkspaceSummary): boolean =>
      workspace.id !== workspaceId && !attachedIds.has(workspace.id),
  );
  const namesById = useMemo(
    (): Map<string, string> => new Map(
      workspaces.map((workspace: WorkspaceSummary): [string, string] => [
        workspace.id,
        workspace.attributes.name,
      ]),
    ),
    [workspaces],
  );

  const attach = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (selectedSourceId === "") return;
    setSaving(true);
    setError("");
    try {
      await fetchApi(`/workspaces/${workspaceId}/relationships/run-triggers`, {
        method: "POST",
        body: JSON.stringify({ data: [{ id: selectedSourceId, type: "workspaces" }] }),
      });
      setSelectedSourceId("");
      await load();
    } catch (caught: unknown) {
      setError(messageFrom(caught, "Failed to add run trigger"));
    } finally {
      setSaving(false);
    }
  };

  const detach = async (sourceWorkspaceId: string): Promise<void> => {
    setError("");
    try {
      await fetchApi(`/workspaces/${workspaceId}/relationships/run-triggers`, {
        method: "DELETE",
        body: JSON.stringify({ data: [{ id: sourceWorkspaceId, type: "workspaces" }] }),
      });
      setTriggers((current: RunTrigger[]): RunTrigger[] =>
        current.filter((trigger: RunTrigger): boolean =>
          trigger.relationships["sourceable-workspace"].data.id !== sourceWorkspaceId,
        ),
      );
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Failed to remove run trigger");
    }
  };

  return (
    <Card className="max-w-4xl">
      <CardHeader>
        <CardTitle>Run triggers</CardTitle>
        <CardDescription>
          Queue a run in this workspace after a successful apply in an upstream workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={attach}>
          <FieldGroup>
            <Field orientation="responsive" data-disabled={loading || saving}>
              <FieldContent>
                <FieldLabel htmlFor="run-trigger-source">Source workspace</FieldLabel>
                <FieldDescription>Select an upstream workspace in {orgName}.</FieldDescription>
              </FieldContent>
              <Select
                id="run-trigger-source"
                value={selectedSourceId}
                onValueChange={setSelectedSourceId}
                disabled={loading || saving || availableWorkspaces.length === 0}
              >
                <SelectItem value="">Select a workspace</SelectItem>
                {availableWorkspaces.map((workspace: WorkspaceSummary): React.JSX.Element => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.attributes.name}
                  </SelectItem>
                ))}
              </Select>
              <Button type="submit" disabled={selectedSourceId === "" || saving}>
                {saving && <Spinner data-icon="inline-start" />}
                {saving ? "Adding" : "Add trigger"}
              </Button>
            </Field>
            <FieldError>{error}</FieldError>
          </FieldGroup>
        </form>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source workspace</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={3} className="h-20 text-center text-muted-foreground">
                    Loading run triggers…
                  </TableCell>
                </TableRow>
              )}
              {!loading && triggers.map((trigger: RunTrigger): React.JSX.Element => {
                const sourceId = trigger.relationships["sourceable-workspace"].data.id;
                const createdAt = trigger.attributes["created-at"];
                return (
                  <TableRow key={trigger.id}>
                    <TableCell className="font-medium">{namesById.get(sourceId) ?? sourceId}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={(): void => { void detach(sourceId); }}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!loading && triggers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="h-20 text-center text-muted-foreground">
                    No upstream workspaces are configured.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

type HealthWorkspace = {
  id: string;
  attributes: {
    name: string;
    "assessments-enabled"?: boolean;
    permissions?: { "can-update"?: boolean };
    [key: string]: JsonValue;
  };
};

type HealthAssessment = {
  id: string;
  attributes: {
    status: string;
    drifted?: boolean | null;
    "resources-drifted"?: number;
    "resources-undrifted"?: number;
    "all-checks-succeeded"?: boolean | null;
    "checks-passed"?: number;
    "checks-failed"?: number;
    "checks-errored"?: number;
    "checks-unknown"?: number;
    "error-msg"?: string | null;
    "created-at"?: string;
    "completed-at"?: string | null;
  };
};

export function WorkspaceHealth({
  workspace,
  onSaved,
}: Readonly<{
  workspace: HealthWorkspace;
  onSaved: (workspace: HealthWorkspace) => void;
}>): React.JSX.Element {
  const [enabled, setEnabled] = useState(workspace.attributes["assessments-enabled"] === true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [assessments, setAssessments] = useState<HealthAssessment[]>([]);
  const [assessmentsLoading, setAssessmentsLoading] = useState(true);
  const canUpdate = workspace.attributes.permissions?.["can-update"] === true;

  useEffect((): (() => void) => {
    const controller = new AbortController();
    setAssessmentsLoading(true);
    void fetchApi<{ data?: HealthAssessment[] }>(
      `/workspaces/${encodeURIComponent(workspace.id)}/assessment-results`,
      { signal: controller.signal },
    )
      .then((response): void => {
        if (!controller.signal.aborted) setAssessments(Array.isArray(response.data) ? response.data : []);
      })
      .catch((): void => {
        if (!controller.signal.aborted) setAssessments([]);
      })
      .finally((): void => {
        if (!controller.signal.aborted) setAssessmentsLoading(false);
      });
    return (): void => { controller.abort(); };
  }, [workspace.id]);

  const save = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!canUpdate) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi(`/workspaces/${workspace.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            id: workspace.id,
            type: "workspaces",
            attributes: { "assessments-enabled": enabled },
          },
        }),
      }) as { data: HealthWorkspace };
      onSaved(response.data);
      setSaved(true);
    } catch (caught: unknown) {
      setError(messageFrom(caught, "Failed to update health assessments"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Latest health result</CardTitle>
          <CardDescription>Drift detection and continuous validation results for this workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          {assessmentsLoading && <p className="text-sm text-muted-foreground">Loading health results…</p>}
          {!assessmentsLoading && assessments[0] === undefined && (
            <p className="text-sm text-muted-foreground">No health assessment has run yet.</p>
          )}
          {!assessmentsLoading && assessments[0] !== undefined && ((): React.JSX.Element => {
            const latest = assessments[0];
            const attrs = latest.attributes;
            const checksFailed = (attrs["checks-failed"] ?? 0) + (attrs["checks-errored"] ?? 0);
            return (
              <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</dt><dd className="mt-1 font-medium capitalize">{attrs.status.replace(/_/g, " ")}</dd></div>
                <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Drift</dt><dd className="mt-1 font-medium">{attrs.drifted === true ? `${attrs["resources-drifted"] ?? 0} resource(s) drifted` : attrs.drifted === false ? "No drift detected" : "Not available"}</dd></div>
                <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Validation</dt><dd className="mt-1 font-medium">{attrs["checks-passed"] ?? 0} passed{checksFailed > 0 ? ` · ${checksFailed} failed` : ""}</dd></div>
                <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Completed</dt><dd className="mt-1 font-medium">{attrs["completed-at"] === null || attrs["completed-at"] === undefined ? "In progress" : formatDate(attrs["completed-at"])}</dd></div>
                {attrs["error-msg"] !== null && attrs["error-msg"] !== undefined && <div className="sm:col-span-2 lg:col-span-4"><dt className="text-xs font-semibold uppercase tracking-wide text-destructive">Error</dt><dd className="mt-1 text-sm text-destructive">{attrs["error-msg"]}</dd></div>}
              </dl>
            );
          })()}
        </CardContent>
      </Card>
      <form onSubmit={save}>
      <Card>
        <CardHeader>
          <CardTitle>Health assessments</CardTitle>
          <CardDescription>
            Configure drift detection and continuous validation checks for this workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field orientation="horizontal" data-disabled={!canUpdate}>
              <Checkbox
                id="workspace-assessments-enabled"
                checked={enabled}
                onCheckedChange={(checked: boolean): void => { setEnabled(checked); }}
                disabled={!canUpdate}
              />
              <FieldContent>
                <FieldLabel htmlFor="workspace-assessments-enabled">Enable health assessments</FieldLabel>
                <FieldDescription>
                  Allow assessment runs to check infrastructure drift and Terraform check blocks.
                </FieldDescription>
              </FieldContent>
            </Field>
            <FieldError>{error}</FieldError>
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-between">
          <span role="status" className="text-sm text-muted-foreground">
            {saved ? "Health assessment setting saved." : ""}
          </span>
          <Button type="submit" disabled={saving || !canUpdate}>
            {saving && <Spinner data-icon="inline-start" />}
            {saving ? "Saving…" : "Save health settings"}
          </Button>
        </CardFooter>
      </Card>
      </form>
    </div>
  );
}
