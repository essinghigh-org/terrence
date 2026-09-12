import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Check } from "lucide-react";
import type { JsonValue } from "../lib/json";
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-changes";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/PageHeader";
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
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectItem } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { useAgentPools } from "@/hooks/useAgentPools";
import type { AgentPoolResource } from "@/hooks/useAgentPools";
import { fetchAllApiPages, fetchApi } from "@/lib/api";
import { cn } from "@/lib/utils";

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

function snapshotSharing(savedSnapshot: WorkspaceSettingsResource): RemoteStateSharing {
  return savedSnapshot.attributes["global-remote-state"] === true
    ? "global"
    : savedSnapshot.attributes["project-remote-state"] === true ? "project" : "specific";
}

function explicitIacBinaryValue(value: unknown): "terraform" | "tofu" | null {
  if (value === "terraform") return "terraform";
  if (value === "tofu") return "tofu";
  return null;
}

function initialIacBinary(value: unknown): IacBinary {
  return value === "terraform" ? "terraform" : "tofu";
}

function initialRemoteStateLoadState(canUpdate: boolean): RemoteStateLoadState {
  return canUpdate ? "loading" : "idle";
}

function doesAgentIgnoreOrgDefault(
  executionMode: ExecutionMode,
  explicit: "terraform" | "tofu" | null,
  orgDefault: IacBinary | null,
): boolean {
  return executionMode === "agent" && explicit === null && orgDefault === "tofu";
}

function effectiveEngineLabel(
  executionMode: ExecutionMode,
  explicit: "terraform" | "tofu" | null,
  orgDefault: IacBinary | null,
): string {
  const agentPins = executionMode === "agent" && explicit === null;
  const binary = agentPins ? "terraform" : (explicit ?? orgDefault ?? "terraform");
  const source = agentPins
    ? "agent execution default"
    : explicit !== null
      ? "this workspace"
      : orgDefault !== null ? "organization default" : "built-in default";
  return `Effective engine: ${binary === "terraform" ? "Terraform" : "OpenTofu"} (${source}).`;
}

function agentPoolOptionsFor(agentPoolId: string, pools: readonly AgentPoolResource[]): readonly AgentPoolResource[] {
  if (agentPoolId === "" || pools.some((pool): boolean => pool.id === agentPoolId)) return pools;
  return [
    {
      id: agentPoolId,
      attributes: { name: `Configured pool (${agentPoolId})` },
    },
    ...pools,
  ];
}

type WorkspaceSettingsForm = Readonly<{
  name: string;
  description: string;
  iacBinary: IacBinary;
  terraformVersion: string;
  executionMode: ExecutionModeSetting;
  agentPoolId: string;
  workingDirectory: string;
  remoteStateSharing: RemoteStateSharing;
  autoApply: boolean;
  autoApplyRunTrigger: boolean;
}>;

function remoteStateConsumersChanged(
  sharing: RemoteStateSharing,
  consumerIds: readonly string[],
  savedKeys: string,
): boolean {
  return sharing === "specific"
    && [...consumerIds].sort().join(",") !== savedKeys;
}

function isSettingsDirty(
  form: WorkspaceSettingsForm,
  savedSnapshot: WorkspaceSettingsResource,
  remoteStateConsumerIds: readonly string[],
  savedConsumerKeys: string,
): boolean {
  return form.name !== savedSnapshot.attributes.name
    || form.description !== (savedSnapshot.attributes.description ?? "")
    || form.iacBinary !== (savedSnapshot.attributes["iac-binary"] === "terraform" ? "terraform" : "tofu")
    || form.terraformVersion !== (savedSnapshot.attributes["terraform-version"] ?? "latest")
    || form.executionMode !== executionModeSetting(savedSnapshot)
    || form.agentPoolId !== agentPoolSetting(savedSnapshot)
    || form.workingDirectory !== (savedSnapshot.attributes["working-directory"] ?? "")
    || form.remoteStateSharing !== snapshotSharing(savedSnapshot)
    || form.autoApply !== (savedSnapshot.attributes["auto-apply"] === true)
    || form.autoApplyRunTrigger !== (savedSnapshot.attributes["auto-apply-run-trigger"] === true)
    || remoteStateConsumersChanged(form.remoteStateSharing, remoteStateConsumerIds, savedConsumerKeys);
}

type SavedWorkspaceSync = Readonly<{
  name: string;
  description: string;
  executionMode: ExecutionModeSetting;
  agentPoolId: string;
  projectExecutionMode: ExecutionMode;
  workingDirectory: string;
  remoteStateSharing: RemoteStateSharing;
  terraformVersion: string;
}>;

function savedWorkspaceSync(data: WorkspaceSettingsResource, normalizedVersion: string): SavedWorkspaceSync {
  return {
    name: data.attributes.name,
    description: data.attributes.description ?? "",
    executionMode: executionModeSetting(data),
    agentPoolId: agentPoolSetting(data),
    projectExecutionMode: parseExecutionMode(data.attributes["execution-mode"]),
    workingDirectory: data.attributes["working-directory"] ?? "",
    remoteStateSharing: snapshotSharing(data),
    terraformVersion: data.attributes["terraform-version"] ?? normalizedVersion,
  };
}

function buildSettingsUpdate(
  normalizedName: string,
  description: string,
  workingDirectory: string,
  remoteStateSharing: RemoteStateSharing,
  iacBinary: IacBinary,
  normalizedVersion: string,
  autoApply: boolean,
  autoApplyRunTrigger: boolean,
  executionMode: ExecutionModeSetting,
  effectiveExecutionMode: ExecutionMode,
  agentPoolId: string,
): WorkspaceSettingsUpdate {
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
  return attributes;
}

async function syncRemoteStateConsumers(
  workspaceId: string,
  consumerIds: readonly string[],
  savedName: string,
  previousName: string,
): Promise<string | null> {
  try {
    await fetchApi(`/workspaces/${workspaceId}/relationships/remote-state-consumers`, {
      method: "PATCH",
      body: JSON.stringify({
        data: [...consumerIds]
          .sort()
          .map((id): { id: string; type: string } => ({ id, type: "workspaces" })),
      }),
    });
    return null;
  } catch (caught: unknown) {
    const detail = caught instanceof Error ? `: ${caught.message}` : ".";
    const message = `Workspace settings were saved, but approved workspaces could not be updated${detail}`;
    if (savedName !== previousName) {
      toast.add({
        title: "Approved workspaces not updated",
        description: message,
        type: "error",
      });
    }
    return message;
  }
}

function GeneralSettingsSection({
  canUpdate,
  invalidName,
  name,
  description,
  onNameChange,
  onDescriptionChange,
}: Readonly<{
  canUpdate: boolean;
  invalidName: boolean;
  name: string;
  description: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
}>): React.JSX.Element {
  return (
    <SettingsSection
      title="General settings"
      description="Name and description for this workspace."
    >
        <FieldGroup>
          <Field data-disabled={!canUpdate} data-invalid={invalidName}>
            <FieldLabel htmlFor="workspace-name">Name</FieldLabel>
            <Input
              id="workspace-name"
              name="workspace-name"
              autoComplete="off"
              spellCheck={false}
              value={name}
              onInput={(event): void => { onNameChange(event.currentTarget.value); }}
              disabled={!canUpdate}
            />
            <FieldDescription>Use letters, numbers, underscores, or hyphens.</FieldDescription>
            {invalidName && <FieldError>Enter a valid workspace name.</FieldError>}
          </Field>
          <Field data-disabled={!canUpdate}>
            <FieldLabel htmlFor="workspace-description">Description</FieldLabel>
            <Textarea
              id="workspace-description"
              name="workspace-description"
              autoComplete="off"
              spellCheck={false}
              rows={3}
              value={description}
              onInput={(event): void => { onDescriptionChange(event.currentTarget.value); }}
              disabled={!canUpdate}
            />
          </Field>
        </FieldGroup>
    </SettingsSection>
  );
}

function ExecutionSettingsSection({
  canUpdate,
  executionMode,
  projectExecutionMode,
  setExecutionMode,
  setAgentPoolId,
  effectiveExecutionMode,
  agentPoolId,
  agentPoolOptions,
  poolsLoading,
  poolsError,
  iacBinary,
  setIacBinary,
  terraformVersion,
  setTerraformVersion,
  workingDirectory,
  setWorkingDirectory,
  engineLabel,
  agentIgnoresOrgDefault,
}: Readonly<{
  canUpdate: boolean;
  executionMode: ExecutionModeSetting;
  projectExecutionMode: ExecutionMode;
  setExecutionMode: Dispatch<SetStateAction<ExecutionModeSetting>>;
  setAgentPoolId: Dispatch<SetStateAction<string>>;
  effectiveExecutionMode: ExecutionMode;
  agentPoolId: string;
  agentPoolOptions: readonly AgentPoolResource[];
  poolsLoading: boolean;
  poolsError: string;
  iacBinary: IacBinary;
  setIacBinary: Dispatch<SetStateAction<IacBinary>>;
  terraformVersion: string;
  setTerraformVersion: Dispatch<SetStateAction<string>>;
  workingDirectory: string;
  setWorkingDirectory: Dispatch<SetStateAction<string>>;
  engineLabel: string;
  agentIgnoresOrgDefault: boolean;
}>): React.JSX.Element {
  return (
    <SettingsSection
      title="Execution"
      description="How and where infrastructure runs execute."
    >
        <FieldGroup className="gap-5">
          <FieldGroup className="grid gap-5 @md/field-group:grid-cols-2">
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
                Use project default or override for this workspace.
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
                  disabled={!canUpdate || poolsLoading}
                >
                  <SelectItem value="">Use project default</SelectItem>
                  {agentPoolOptions.map((pool): React.JSX.Element => (
                    <SelectItem key={pool.id} value={pool.id}>{pool.attributes.name}</SelectItem>
                  ))}
                </Select>
                <FieldDescription>
                  Select a workspace-specific agent pool.
                </FieldDescription>
                {poolsLoading && <span className="text-xs text-muted-foreground">Loading agent pools…</span>}
                {poolsError !== "" && <FieldError>{poolsError}</FieldError>}
              </Field>
            )}
          </FieldGroup>

          <FieldGroup className="grid gap-5 @md/field-group:grid-cols-2">
            <Field data-disabled={!canUpdate}>
              <FieldLabel htmlFor="workspace-iac-binary">Execution engine</FieldLabel>
              <Select
                id="workspace-iac-binary"
                name="iac-binary"
                value={iacBinary}
                onValueChange={(value: string): void => {
                  setIacBinary(value as IacBinary);
                }}
                disabled={!canUpdate}
              >
                <SelectItem value="tofu">OpenTofu</SelectItem>
                <SelectItem value="terraform">Terraform</SelectItem>
              </Select>
              <FieldDescription>
                Binary used for plans and applies. {engineLabel}
              </FieldDescription>
              {agentIgnoresOrgDefault && (
                <p className="text-sm text-muted-foreground mt-1">
                  <span className="font-medium text-foreground">Agent runs will use Terraform.</span>
                  {" "}Agent execution ignores the organization default when no engine is set here.
                  Select an explicit engine to pin both local and agent runs.
                </p>
              )}
            </Field>

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
                Use latest or a version constraint.
              </FieldDescription>
            </Field>
          </FieldGroup>

          <Field data-disabled={!canUpdate}>
            <FieldLabel htmlFor="workspace-working-directory">{iacBinary === "tofu" ? "OpenTofu" : "Terraform"} working directory</FieldLabel>
            <Input
              id="workspace-working-directory"
              name="working-directory"
              autoComplete="off"
              spellCheck={false}
              value={workingDirectory}
              onInput={(event): void => { setWorkingDirectory(event.currentTarget.value); }}
              placeholder="Defaults to repository root"
              disabled={!canUpdate}
            />
            <FieldDescription>
              A relative subdirectory within the configuration where execution occurs.
            </FieldDescription>
          </Field>
        </FieldGroup>
    </SettingsSection>
  );
}

function RemoteStateSection({
  canUpdate,
  sharing,
  setSharing,
  loadState,
  loadError,
  onRetry,
  workspaces,
  consumerIds,
  setConsumerIds,
}: Readonly<{
  canUpdate: boolean;
  sharing: RemoteStateSharing;
  setSharing: Dispatch<SetStateAction<RemoteStateSharing>>;
  loadState: RemoteStateLoadState;
  loadError: string;
  onRetry: () => void;
  workspaces: readonly RemoteStateWorkspace[];
  consumerIds: readonly string[];
  setConsumerIds: Dispatch<SetStateAction<string[]>>;
}>): React.JSX.Element {
  return (
    <SettingsSection
      title="State sharing"
      description="Which workspaces may read this workspace's outputs through remote state."
    >
        <FieldGroup className="gap-4">
          <Field data-disabled={!canUpdate}>
            <FieldLabel htmlFor="workspace-remote-state-sharing">Remote state sharing</FieldLabel>
            <Select
              id="workspace-remote-state-sharing"
              name="remote-state-sharing"
              value={sharing}
              onValueChange={(value: string): void => {
                setSharing(value as RemoteStateSharing);
              }}
              disabled={!canUpdate}
            >
              <SelectItem value="specific">Specific approved workspaces</SelectItem>
              <SelectItem value="project">All workspaces in this project</SelectItem>
              <SelectItem value="global">All workspaces in this organization</SelectItem>
            </Select>
          </Field>

          {sharing === "specific" && (
            <FieldSet
              disabled={!canUpdate}
              className="rounded-lg border border-border bg-muted/20 p-4"
            >
              <FieldLegend variant="label">Approved workspaces</FieldLegend>
              <FieldDescription>
                Select the workspaces that may read this workspace&apos;s outputs.
              </FieldDescription>
              {loadState === "loading" && (
                <span
                  role="status"
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <Spinner data-icon="inline-start" />
                  Loading approved workspaces…
                </span>
              )}
              {loadState === "error" && (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <FieldError role="alert">{loadError}</FieldError>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onRetry}
                  >
                    Try again
                  </Button>
                  <p className="w-full text-sm text-muted-foreground">
                    Saving other settings will leave the current approved workspace list unchanged.
                  </p>
                </div>
              )}
              {loadState === "ready" && workspaces.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  There are no other workspaces in this organization.
                </p>
              )}
              {loadState === "ready" && workspaces.length > 0 && (
                <FieldGroup
                  data-slot="checkbox-group"
                  className="max-h-56 gap-0 overflow-y-auto rounded-lg border border-border bg-background"
                >
                  {workspaces.map((candidate): React.JSX.Element => (
                    <Field
                      key={candidate.id}
                      orientation="horizontal"
                      className="border-b border-border px-3 py-2.5 last:border-b-0"
                    >
                      <Checkbox
                        id={`remote-state-consumer-${candidate.id}`}
                        checked={consumerIds.includes(candidate.id)}
                        onCheckedChange={(checked: boolean): void => {
                          setConsumerIds((current): string[] => checked
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
        </FieldGroup>
    </SettingsSection>
  );
}

function SettingsFormFooter({
  error,
  justSaved,
  canUpdate,
  saving,
  invalidName,
  dirty,
}: Readonly<{
  error: string;
  justSaved: boolean;
  canUpdate: boolean;
  saving: boolean;
  invalidName: boolean;
  dirty: boolean;
}>): React.JSX.Element {
  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-x-4 gap-y-2 rounded-xl bg-card/95 px-4 py-3 ring-1 ring-border/80 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      {error !== "" && <FieldError className="mr-auto">{error}</FieldError>}
      {/* On success the button already says "Saved", so the live region goes
          sr-only rather than repeating it on screen. It stays mounted and
          visible for the permission message, which has no other home. */}
      <span
        role="status"
        className={cn("text-sm text-muted-foreground", justSaved && "sr-only")}
      >
        {justSaved ? "Settings saved." : canUpdate ? "" : "You do not have permission to update this workspace."}
      </span>
      <Button type="submit" disabled={saving || !canUpdate || invalidName || !dirty}>
        {saving && <Spinner data-icon="inline-start" />}
        {justSaved && <Check data-icon="inline-start" aria-hidden="true" />}
        {saving ? "Saving…" : justSaved ? "Saved" : "Save settings"}
      </Button>
    </div>
  );
}

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
    initialIacBinary(workspace.attributes["iac-binary"]),
  );
  const [terraformVersion, setTerraformVersion] = useState(
    workspace.attributes["terraform-version"] ?? "latest",
  );
  const [name, setName] = useState(workspace.attributes.name);
  const [description, setDescription] = useState(workspace.attributes.description ?? "");
  const [executionMode, setExecutionMode] = useState<ExecutionModeSetting>(executionModeSetting(workspace));
  const [agentPoolId, setAgentPoolId] = useState(agentPoolSetting(workspace));
  const [projectExecutionMode, setProjectExecutionMode] = useState<ExecutionMode>(workspaceExecutionMode);
  const [orgDefaultIacBinary, setOrgDefaultIacBinary] = useState<IacBinary | null>(null);
  const [workingDirectory, setWorkingDirectory] = useState(
    workspace.attributes["working-directory"] ?? "",
  );
  const [remoteStateSharing, setRemoteStateSharing] = useState<RemoteStateSharing>(
    snapshotSharing(workspace),
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
    initialRemoteStateLoadState(canUpdate),
  );
  const [remoteStateLoadError, setRemoteStateLoadError] = useState("");
  const [remoteStateReload, setRemoteStateReload] = useState(0);
  const [savedSnapshot, setSavedSnapshot] = useState<WorkspaceSettingsResource>(workspace);
  const [savedConsumerKeys, setSavedConsumerKeys] = useState("");

  const projectId = workspace.relationships?.project?.data?.id ?? "";
  const effectiveExecutionMode = executionMode === "inherit" ? projectExecutionMode : executionMode;
  // Issue #600: surface the workspace value next to the effective engine and
  // warn when agent runs will ignore the organization default. Agent
  // execution pins Terraform unless an engine is set here, so on agent
  // workspaces the agent default wins over the organization default.
  const explicitIacBinary = explicitIacBinaryValue(workspace.attributes["iac-binary"]);
  const engineLabel = effectiveEngineLabel(effectiveExecutionMode, explicitIacBinary, orgDefaultIacBinary);
  const agentIgnoresOrgDefault = doesAgentIgnoreOrgDefault(
    effectiveExecutionMode,
    explicitIacBinary,
    orgDefaultIacBinary,
  );
  const agentPoolsState = useAgentPools(orgName, canUpdate && effectiveExecutionMode === "agent");

  const normalizedName = name.trim();
  const invalidName = normalizedName === "" || !/^[A-Za-z0-9_-]+$/.test(normalizedName);

  const dirty = isSettingsDirty(
    {
      name,
      description,
      iacBinary,
      terraformVersion,
      executionMode,
      agentPoolId,
      workingDirectory,
      remoteStateSharing,
      autoApply,
      autoApplyRunTrigger,
    },
    savedSnapshot,
    remoteStateConsumerIds,
    savedConsumerKeys,
  );

  useUnsavedChangesWarning(dirty);

  // `saved` alone goes stale the moment the user edits again; pair it with the
  // dirty check so the confirmation only stands while it is still true.
  const justSaved = saved && !dirty && error === "";

  const agentPoolOptions: readonly AgentPoolResource[] = agentPoolOptionsFor(agentPoolId, agentPoolsState.pools);

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
        { retryAttempts: 0 },
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
    }).catch((caught: unknown): void => {
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

  useEffect((): (() => void) => {
    const controller = new AbortController();
    setOrgDefaultIacBinary(null);
    if (orgName === "") {
      return (): void => { controller.abort(); };
    }

    void fetchApi<{ data?: { attributes?: { "default-iac-binary"?: string } } }>(
      `/organizations/${encodeURIComponent(orgName)}`,
      { signal: controller.signal },
    )
      .then((response): void => {
        if (controller.signal.aborted) return;
        const value = response.data?.attributes?.["default-iac-binary"];
        setOrgDefaultIacBinary(value === "terraform" || value === "tofu" ? value : null);
      })
      .catch((): void => {
        // The effective engine falls back to the built-in default when the
        // organization document cannot be read by the current principal.
      });

    return (): void => { controller.abort(); };
  }, [orgName, workspace.id]);

  const saveSettings = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!canUpdate || invalidName) return;
    const normalizedVersion = terraformVersion.trim() === "" ? "latest" : terraformVersion.trim();
    const attributes = buildSettingsUpdate(
      normalizedName,
      description,
      workingDirectory,
      remoteStateSharing,
      iacBinary,
      normalizedVersion,
      autoApply,
      autoApplyRunTrigger,
      executionMode,
      effectiveExecutionMode,
      agentPoolId,
    );
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
      const synced = savedWorkspaceSync(response.data, normalizedVersion);
      setSavedSnapshot(response.data);
      setName(synced.name);
      setDescription(synced.description);
      setExecutionMode(synced.executionMode);
      setAgentPoolId(synced.agentPoolId);
      setProjectExecutionMode(synced.projectExecutionMode);
      setWorkingDirectory(synced.workingDirectory);
      setRemoteStateSharing(synced.remoteStateSharing);
      setTerraformVersion(synced.terraformVersion);
      setSaved(true);
      if (remoteStateLoadState === "ready") {
        const syncError = await syncRemoteStateConsumers(
          workspace.id,
          [...remoteStateConsumerIds],
          response.data.attributes.name,
          workspace.attributes.name,
        );
        if (syncError === null) {
          setSavedConsumerKeys([...remoteStateConsumerIds].sort().join(","));
        } else {
          setError(syncError);
          setSaved(false);
        }
      }
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Failed to save workspace settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={saveSettings} noValidate className="space-y-6">
      <GeneralSettingsSection
        canUpdate={canUpdate}
        invalidName={invalidName}
        name={name}
        description={description}
        onNameChange={(value: string): void => { setName(value); }}
        onDescriptionChange={(value: string): void => { setDescription(value); }}
      />

      <ExecutionSettingsSection
        canUpdate={canUpdate}
        executionMode={executionMode}
        projectExecutionMode={projectExecutionMode}
        setExecutionMode={setExecutionMode}
        setAgentPoolId={setAgentPoolId}
        effectiveExecutionMode={effectiveExecutionMode}
        agentPoolId={agentPoolId}
        agentPoolOptions={agentPoolOptions}
        poolsLoading={agentPoolsState.loading}
        poolsError={agentPoolsState.error}
        iacBinary={iacBinary}
        setIacBinary={setIacBinary}
        terraformVersion={terraformVersion}
        setTerraformVersion={setTerraformVersion}
        workingDirectory={workingDirectory}
        setWorkingDirectory={setWorkingDirectory}
        engineLabel={engineLabel}
        agentIgnoresOrgDefault={agentIgnoresOrgDefault}
      />

      <RemoteStateSection
        canUpdate={canUpdate}
        sharing={remoteStateSharing}
        setSharing={setRemoteStateSharing}
        loadState={remoteStateLoadState}
        loadError={remoteStateLoadError}
        onRetry={(): void => { setRemoteStateReload((current): number => current + 1); }}
        workspaces={remoteStateWorkspaces}
        consumerIds={remoteStateConsumerIds}
        setConsumerIds={setRemoteStateConsumerIds}
      />

      <SettingsSection
        title="Automatic apply"
        description="Whether successful plans apply on their own."
      >
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
      </SettingsSection>

      {/* One submit saves all four sections, so the action belongs to the form
          rather than to whichever section happens to be last. Sticky keeps it
          reachable without scrolling back down a long page.

          The button tracks the form's dirty state — `dirty` already drives the
          navigation guard, so an enabled Save with nothing to save was the two
          disagreeing. Pristine and just-saved both read as "nothing to do". */}
      <SettingsFormFooter
        error={error}
        justSaved={justSaved}
        canUpdate={canUpdate}
        saving={saving}
        invalidName={invalidName}
        dirty={dirty}
      />
    </form>
  );
}
