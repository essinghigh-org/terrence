import { useEffect, useState } from "react";
import type { JsonValue } from "../lib/json";
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-changes";
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
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { useAgentPools } from "@/hooks/useAgentPools";
import type { AgentPoolResource } from "@/hooks/useAgentPools";
import { fetchAllApiPages, fetchApi } from "@/lib/api";

type WorkspaceSettingsResource = {
  id: string;
  attributes: {
    name: string;
    description?: string | null;
    "auto-apply"?: boolean;
    "auto-apply-run-trigger"?: boolean;
    "agent-pool-id"?: string | null;
    "execution-mode"?: string;
    "global-remote-state"?: boolean;
    "iac-binary"?: string;
    "project-remote-state"?: boolean;
    "setting-overwrites"?: Readonly<Record<string, boolean>>;
    "terraform-version"?: string;
    "working-directory"?: string | null;
    permissions?: { "can-update"?: boolean };
    [key: string]: JsonValue;
  };
  relationships?: {
    project?: { data: { id: string; type: string } | null };
  };
};

type IacBinary = "tofu" | "terraform";
type ExecutionMode = "agent" | "local" | "remote";
type ExecutionModeSetting = ExecutionMode | "inherit";
type RemoteStateSharing = "global" | "project" | "specific";
type RemoteStateLoadState = "error" | "idle" | "loading" | "ready";

type ProjectSettingsResource = {
  attributes?: {
    "default-execution-mode"?: string;
  };
};

type ProjectSettingsResponse = {
  data?: ProjectSettingsResource;
};

type WorkspaceSettingsUpdate = {
  name: string;
  description: string | null;
  "working-directory": string;
  "global-remote-state": boolean;
  "project-remote-state": boolean;
  "iac-binary": IacBinary;
  "terraform-version": string;
  "auto-apply": boolean;
  "auto-apply-run-trigger": boolean;
  "setting-overwrites": {
    "execution-mode": boolean;
    "agent-pool": boolean;
  };
  "execution-mode"?: ExecutionMode;
  "agent-pool-id"?: string;
};

function parseExecutionMode(value: string | undefined): ExecutionMode {
  return value === "agent" || value === "local" ? value : "remote";
}

function executionModeSetting(resource: WorkspaceSettingsResource): ExecutionModeSetting {
  return resource.attributes["setting-overwrites"]?.["execution-mode"] === true
    ? parseExecutionMode(resource.attributes["execution-mode"])
    : "inherit";
}

function agentPoolSetting(resource: WorkspaceSettingsResource): string {
  return resource.attributes["setting-overwrites"]?.["agent-pool"] === true
    ? resource.attributes["agent-pool-id"] ?? ""
    : "";
}

type RemoteStateWorkspace = {
  id: string;
  attributes: {
    name: string;
  };
};

export function WorkspaceSettings({
  orgName,
  workspace,
  onSaved,
}: Readonly<{
  orgName: string;
  workspace: WorkspaceSettingsResource;
  onSaved: (workspace: WorkspaceSettingsResource) => void;
}>): React.JSX.Element {
  const canUpdate = workspace.attributes.permissions?.["can-update"] === true;
  const workspaceExecutionMode = parseExecutionMode(workspace.attributes["execution-mode"]);
  const [iacBinary, setIacBinary] = useState<IacBinary>(
    workspace.attributes["iac-binary"] === "terraform" ? "terraform" : "tofu",
  );
  const [terraformVersion, setTerraformVersion] = useState(
    workspace.attributes["terraform-version"] ?? "latest",
  );
  const [name, setName] = useState(workspace.attributes.name);
  const [description, setDescription] = useState(workspace.attributes.description ?? "");
  const [executionMode, setExecutionMode] = useState<ExecutionModeSetting>(executionModeSetting(workspace));
  const [agentPoolId, setAgentPoolId] = useState(agentPoolSetting(workspace));
  const [projectExecutionMode, setProjectExecutionMode] = useState<ExecutionMode>(workspaceExecutionMode);
  const [workingDirectory, setWorkingDirectory] = useState(
    workspace.attributes["working-directory"] ?? "",
  );
  const [remoteStateSharing, setRemoteStateSharing] = useState<RemoteStateSharing>(
    workspace.attributes["global-remote-state"] === true
      ? "global"
      : workspace.attributes["project-remote-state"] === true ? "project" : "specific",
  );
  const [autoApply, setAutoApply] = useState(workspace.attributes["auto-apply"] === true);
  const [autoApplyRunTrigger, setAutoApplyRunTrigger] = useState(
    workspace.attributes["auto-apply-run-trigger"] === true,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [remoteStateWorkspaces, setRemoteStateWorkspaces] = useState<RemoteStateWorkspace[]>([]);
  const [remoteStateConsumerIds, setRemoteStateConsumerIds] = useState<string[]>([]);
  const [remoteStateLoadState, setRemoteStateLoadState] = useState<RemoteStateLoadState>(
    canUpdate ? "loading" : "idle",
  );
  const [remoteStateLoadError, setRemoteStateLoadError] = useState("");
  const [remoteStateReload, setRemoteStateReload] = useState(0);
  const [savedSnapshot, setSavedSnapshot] = useState<WorkspaceSettingsResource>(workspace);
  const [savedConsumerKeys, setSavedConsumerKeys] = useState("");

  const projectId = workspace.relationships?.project?.data?.id ?? "";
  const effectiveExecutionMode = executionMode === "inherit" ? projectExecutionMode : executionMode;
  const agentPoolsState = useAgentPools(orgName, canUpdate && effectiveExecutionMode === "agent");

  const normalizedName = name.trim();
  const invalidName = normalizedName === "" || !/^[A-Za-z0-9_-]+$/.test(normalizedName);

  const dirty =
    name !== savedSnapshot.attributes.name
    || description !== (savedSnapshot.attributes.description ?? "")
    || iacBinary !== (savedSnapshot.attributes["iac-binary"] === "terraform" ? "terraform" : "tofu")
    || terraformVersion !== (savedSnapshot.attributes["terraform-version"] ?? "latest")
    || executionMode !== executionModeSetting(savedSnapshot)
    || agentPoolId !== agentPoolSetting(savedSnapshot)
    || workingDirectory !== (savedSnapshot.attributes["working-directory"] ?? "")
    || remoteStateSharing !== (
      savedSnapshot.attributes["global-remote-state"] === true
        ? "global"
        : savedSnapshot.attributes["project-remote-state"] === true ? "project" : "specific"
    )
    || autoApply !== (savedSnapshot.attributes["auto-apply"] === true)
    || autoApplyRunTrigger !== (savedSnapshot.attributes["auto-apply-run-trigger"] === true)
    || (remoteStateSharing === "specific"
      && [...remoteStateConsumerIds].sort().join(",") !== savedConsumerKeys);

  useUnsavedChangesWarning(dirty);

  const agentPoolOptions: AgentPoolResource[] = agentPoolId !== ""
    && !agentPoolsState.pools.some((pool): boolean => pool.id === agentPoolId)
    ? [
        {
          id: agentPoolId,
          attributes: { name: `Configured pool (${agentPoolId})` },
        },
        ...agentPoolsState.pools,
      ]
    : agentPoolsState.pools;

  useEffect((): (() => void) | undefined => {
    if (!canUpdate) {
      setRemoteStateWorkspaces([]);
      setRemoteStateConsumerIds([]);
      setRemoteStateLoadState("idle");
      setRemoteStateLoadError("");
      return undefined;
    }

    const controller = new AbortController();
    setRemoteStateWorkspaces([]);
    setRemoteStateConsumerIds([]);
    setRemoteStateLoadState("loading");
    setRemoteStateLoadError("");
    // SAFETY: the consumers endpoint returns the JSON:API envelope per contract.
    void Promise.all([
      fetchAllApiPages<RemoteStateWorkspace>(
        `/organizations/${encodeURIComponent(orgName)}/workspaces?page[size]=100`,
        controller.signal,
      ),
      fetchApi(
        `/workspaces/${workspace.id}/relationships/remote-state-consumers`,
        { signal: controller.signal },
      ) as Promise<{ data?: { id: string; type?: string }[] }>,
    ]).then(([workspaces, consumers]): void => {
      if (controller.signal.aborted) return;
      setRemoteStateWorkspaces(
        workspaces
          .filter((candidate): boolean => candidate.id !== workspace.id)
          .sort((left, right): number => {
            const byName = left.attributes.name.localeCompare(right.attributes.name);
            return byName === 0 ? left.id.localeCompare(right.id) : byName;
          }),
      );
      setRemoteStateConsumerIds([
        ...new Set(
          (Array.isArray(consumers.data) ? consumers.data : [])
            .map((consumer): string => consumer.id)
            .filter((id): boolean => id !== ""),
        ),
      ]);
      setSavedConsumerKeys(
        [
          ...new Set(
            (Array.isArray(consumers.data) ? consumers.data : [])
              .map((consumer): string => consumer.id)
              .filter((id): boolean => id !== ""),
          ),
        ].sort().join(","),
      );
      setRemoteStateLoadState("ready");
    }).catch((caught): void => {
      if (controller.signal.aborted) return;
      setRemoteStateLoadState("error");
      setRemoteStateLoadError(
        caught instanceof Error
          ? `Could not load approved workspaces: ${caught.message}`
          : "Could not load approved workspaces.",
      );
    });

    return (): void => { controller.abort(); };
  }, [canUpdate, orgName, remoteStateReload, workspace.id]);

  useEffect((): (() => void) => {
    const controller = new AbortController();
    setProjectExecutionMode(workspaceExecutionMode);
    if (projectId === "") {
      return (): void => { controller.abort(); };
    }

    void fetchApi<ProjectSettingsResponse>(`/projects/${encodeURIComponent(projectId)}`, { signal: controller.signal })
      .then((response): void => {
        if (controller.signal.aborted) return;
        setProjectExecutionMode(parseExecutionMode(response.data?.attributes?.["default-execution-mode"]));
      })
      .catch((): void => {
        // The workspace's effective mode remains a safe fallback when the
        // project document cannot be read by the current principal.
      });

    return (): void => { controller.abort(); };
  }, [projectId, workspace.id, workspaceExecutionMode]);

  const saveSettings = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!canUpdate || invalidName) return;
    const normalizedVersion = terraformVersion.trim() === "" ? "latest" : terraformVersion.trim();
    const attributes: WorkspaceSettingsUpdate = {
      name: normalizedName,
      description: description.trim() === "" ? null : description.trim(),
      "working-directory": workingDirectory.trim(),
      "global-remote-state": remoteStateSharing === "global",
      "project-remote-state": remoteStateSharing === "project",
      "iac-binary": iacBinary,
      "terraform-version": normalizedVersion,
      "auto-apply": autoApply,
      "auto-apply-run-trigger": autoApplyRunTrigger,
      "setting-overwrites": {
        "execution-mode": executionMode !== "inherit",
        "agent-pool": effectiveExecutionMode === "agent" && agentPoolId !== "",
      },
    };
    if (executionMode !== "inherit") attributes["execution-mode"] = executionMode;
    if (effectiveExecutionMode === "agent" && agentPoolId !== "") {
      attributes["agent-pool-id"] = agentPoolId;
    }
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
            attributes,
          },
        }),
      }) as { data: WorkspaceSettingsResource };
      onSaved(response.data);
      setSavedSnapshot(response.data);
      setName(response.data.attributes.name);
      setDescription(response.data.attributes.description ?? "");
      setExecutionMode(executionModeSetting(response.data));
      setAgentPoolId(agentPoolSetting(response.data));
      setProjectExecutionMode(parseExecutionMode(response.data.attributes["execution-mode"]));
      setWorkingDirectory(response.data.attributes["working-directory"] ?? "");
      setRemoteStateSharing(
        response.data.attributes["global-remote-state"] === true
          ? "global"
          : response.data.attributes["project-remote-state"] === true ? "project" : "specific",
      );
      setTerraformVersion(response.data.attributes["terraform-version"] ?? normalizedVersion);
      setSaved(true);
      if (remoteStateLoadState === "ready") {
        try {
          await fetchApi(`/workspaces/${workspace.id}/relationships/remote-state-consumers`, {
            method: "PATCH",
            body: JSON.stringify({
              data: [...remoteStateConsumerIds]
                .sort()
                .map((id) => ({ id, type: "workspaces" })),
            }),
          });
          setSavedConsumerKeys([...remoteStateConsumerIds].sort().join(","));
        } catch (caught: unknown) {
          const detail = caught instanceof Error ? `: ${caught.message}` : ".";
          const message = `Workspace settings were saved, but approved workspaces could not be updated${detail}`;
          setError(message);
          if (response.data.attributes.name !== workspace.attributes.name) {
            toast.add({
              title: "Approved workspaces not updated",
              description: message,
              type: "error",
            });
          }
        }
      }
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Failed to save workspace settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={saveSettings} noValidate className="max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>General settings</CardTitle>
          <CardDescription>
            Configure this workspace&apos;s identity, execution, state sharing, and apply behavior.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-disabled={!canUpdate} data-invalid={invalidName}>
              <FieldLabel htmlFor="workspace-name">Name</FieldLabel>
              <Input
                id="workspace-name"
                name="workspace-name"
                autoComplete="off"
                spellCheck={false}
                value={name}
                onInput={(event): void => { setName(event.currentTarget.value); }}
                disabled={!canUpdate}
              />
              <FieldDescription>Use letters, numbers, underscores, or hyphens.</FieldDescription>
              {invalidName && <FieldError>Enter a valid workspace name.</FieldError>}
            </Field>
            <Field data-disabled={!canUpdate}>
              <FieldLabel htmlFor="workspace-description">Description</FieldLabel>
              <textarea
                id="workspace-description"
                name="workspace-description"
                autoComplete="off"
                spellCheck={false}
                rows={4}
                value={description}
                onInput={(event): void => { setDescription(event.currentTarget.value); }}
                disabled={!canUpdate}
                className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
            </Field>
            <Field data-disabled={!canUpdate}>
              <FieldLabel htmlFor="workspace-execution-mode">Execution mode</FieldLabel>
              <Select
                id="workspace-execution-mode"
                name="execution-mode"
                value={executionMode}
                onValueChange={(value: string): void => {
                  const nextMode: ExecutionModeSetting = value === "agent" || value === "local" || value === "remote"
                    ? value
                    : "inherit";
                  setExecutionMode(nextMode);
                  const nextEffectiveMode = nextMode === "inherit" ? projectExecutionMode : nextMode;
                  if (nextEffectiveMode !== "agent") setAgentPoolId("");
                }}
                disabled={!canUpdate}
              >
                <SelectItem value="inherit">Use project default</SelectItem>
                <SelectItem value="remote">Remote</SelectItem>
                <SelectItem value="local">Local</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
              </Select>
              <FieldDescription>
                Use the project default, or override execution for this workspace.
              </FieldDescription>
            </Field>
            {effectiveExecutionMode === "agent" && (
              <Field data-disabled={!canUpdate}>
                <FieldLabel htmlFor="workspace-agent-pool">Agent pool</FieldLabel>
                <Select
                  id="workspace-agent-pool"
                  name="agent-pool"
                  value={agentPoolId}
                  onValueChange={setAgentPoolId}
                  disabled={!canUpdate || agentPoolsState.loading}
                >
                  <SelectItem value="">Use project default</SelectItem>
                  {agentPoolOptions.map((pool): React.JSX.Element => (
                    <SelectItem key={pool.id} value={pool.id}>{pool.attributes.name}</SelectItem>
                  ))}
                </Select>
                <FieldDescription>
                  Use the project&apos;s pool, or select a workspace-specific pool.
                </FieldDescription>
                {agentPoolsState.loading && <span className="text-xs text-muted-foreground">Loading agent pools…</span>}
                {agentPoolsState.error !== "" && <FieldError>{agentPoolsState.error}</FieldError>}
              </Field>
            )}
            <Field data-disabled={!canUpdate}>
              <FieldLabel htmlFor="workspace-iac-binary">Execution engine</FieldLabel>
              <Select
                id="workspace-iac-binary"
                name="iac-binary"
                value={iacBinary}
// SAFETY: the select options are generated from the same union; the change event carries one of them.
                onValueChange={(value: string): void => {

                  // SAFETY: the change event carries one of the union values the UI renders from the same options.

                  setIacBinary(value as IacBinary);

                }}
                disabled={!canUpdate}
              >
                <SelectItem value="tofu">OpenTofu</SelectItem>
                <SelectItem value="terraform">Terraform</SelectItem>
              </Select>
              <FieldDescription>
                Select the infrastructure-as-code binary used for plans and applies.
              </FieldDescription>
            </Field>
            <Field data-disabled={!canUpdate}>
              <FieldLabel htmlFor="workspace-working-directory">Terraform working directory</FieldLabel>
              <Input
                id="workspace-working-directory"
                name="working-directory"
                autoComplete="off"
                spellCheck={false}
                value={workingDirectory}
                onInput={(event): void => { setWorkingDirectory(event.currentTarget.value); }}
                placeholder="Defaults to the repository root"
                disabled={!canUpdate}
              />
              <FieldDescription>
                A relative subdirectory within the configuration where the execution engine runs.
              </FieldDescription>
            </Field>
            <Field data-disabled={!canUpdate}>
              <FieldLabel htmlFor="workspace-remote-state-sharing">Remote state sharing</FieldLabel>
              <Select
                id="workspace-remote-state-sharing"
                name="remote-state-sharing"
                value={remoteStateSharing}
// SAFETY: the select options are generated from the same union; the change event carries one of them.
                onValueChange={(value: string): void => {

                  // SAFETY: the change event carries one of the union values the UI renders from the same options.

                  setRemoteStateSharing(value as RemoteStateSharing);

                }}
                disabled={!canUpdate}
              >
                <SelectItem value="specific">Specific approved workspaces</SelectItem>
                <SelectItem value="project">All workspaces in this project</SelectItem>
                <SelectItem value="global">All workspaces in this organization</SelectItem>
              </Select>
              <FieldDescription>
                Controls which workspaces may read this workspace&apos;s outputs through remote state.
              </FieldDescription>
            </Field>
            {remoteStateSharing === "specific" && (
              <FieldSet
                disabled={!canUpdate}
                className="rounded-lg border border-border bg-muted/20 p-4"
              >
                <FieldLegend variant="label">Approved workspaces</FieldLegend>
                <FieldDescription>
                  Select the workspaces that may read this workspace&apos;s outputs.
                </FieldDescription>
                {remoteStateLoadState === "loading" && (
                  <span
                    role="status"
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    <Spinner data-icon="inline-start" />
                    Loading approved workspaces…
                  </span>
                )}
                {remoteStateLoadState === "error" && (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <FieldError role="alert">{remoteStateLoadError}</FieldError>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={(): void => { setRemoteStateReload((current): number => current + 1); }}
                    >
                      Try again
                    </Button>
                    <p className="w-full text-sm text-muted-foreground">
                      Saving other settings will leave the current approved workspace list unchanged.
                    </p>
                  </div>
                )}
                {remoteStateLoadState === "ready" && remoteStateWorkspaces.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    There are no other workspaces in this organization.
                  </p>
                )}
                {remoteStateLoadState === "ready" && remoteStateWorkspaces.length > 0 && (
                  <FieldGroup
                    data-slot="checkbox-group"
                    className="max-h-56 gap-0 overflow-y-auto rounded-lg border border-border bg-background"
                  >
                    {remoteStateWorkspaces.map((candidate): React.JSX.Element => (
                      <Field
                        key={candidate.id}
                        orientation="horizontal"
                        className="border-b border-border px-3 py-2.5 last:border-b-0"
                      >
                        <Checkbox
                          id={`remote-state-consumer-${candidate.id}`}
                          checked={remoteStateConsumerIds.includes(candidate.id)}
                          onCheckedChange={(checked: boolean): void => {
                            setRemoteStateConsumerIds((current): string[] => checked
                              ? current.includes(candidate.id) ? current : [...current, candidate.id]
                              : current.filter((id): boolean => id !== candidate.id));
                          }}
                          disabled={!canUpdate}
                        />
                        <FieldLabel htmlFor={`remote-state-consumer-${candidate.id}`}>
                          {candidate.attributes.name}
                        </FieldLabel>
                      </Field>
                    ))}
                  </FieldGroup>
                )}
              </FieldSet>
            )}
            <Field data-disabled={!canUpdate}>
              <FieldLabel htmlFor="workspace-terraform-version">Engine version</FieldLabel>
              <Input
                id="workspace-terraform-version"
                name="terraform-version"
                autoComplete="off"
                spellCheck={false}
                value={terraformVersion}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                  setTerraformVersion(event.target.value);
                }}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                  setTerraformVersion(event.currentTarget.value);
                }}
                placeholder="latest or 1.9.3"
                disabled={!canUpdate}
              />
              <FieldDescription>
                Use latest, an exact version, or a supported version constraint.
              </FieldDescription>
            </Field>
            <FieldSet disabled={!canUpdate}>
              <FieldLegend variant="label">Automatic apply</FieldLegend>
              <FieldDescription>
                Successful plans require confirmation unless the applicable option is enabled.
              </FieldDescription>
              <FieldGroup className="gap-3">
                <Field orientation="horizontal" data-disabled={!canUpdate}>
                  <Checkbox
                    id="workspace-auto-apply"
                    checked={autoApply}
                    onCheckedChange={(checked: boolean): void => { setAutoApply(checked); }}
                    disabled={!canUpdate}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="workspace-auto-apply">Auto-apply API, UI, and VCS runs</FieldLabel>
                    <FieldDescription>Apply changes automatically after a successful plan.</FieldDescription>
                  </FieldContent>
                </Field>
                <Field orientation="horizontal" data-disabled={!canUpdate}>
                  <Checkbox
                    id="workspace-auto-apply-run-trigger"
                    checked={autoApplyRunTrigger}
                    onCheckedChange={(checked: boolean): void => { setAutoApplyRunTrigger(checked); }}
                    disabled={!canUpdate}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="workspace-auto-apply-run-trigger">Auto-apply run-triggered runs</FieldLabel>
                    <FieldDescription>
                      Apply runs created when an upstream workspace finishes.
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </FieldGroup>
            </FieldSet>
            <FieldError>{error}</FieldError>
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-between">
          <span role="status" className="text-sm text-muted-foreground">
            {saved ? "Settings saved." : canUpdate ? "" : "You do not have permission to update this workspace."}
          </span>
          <Button type="submit" disabled={saving || !canUpdate || invalidName}>
            {saving && <Spinner data-icon="inline-start" />}
            {saving ? "Saving" : "Save settings"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}