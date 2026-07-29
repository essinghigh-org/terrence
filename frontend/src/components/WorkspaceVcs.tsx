import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
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
import { fetchApi } from "@/lib/api";

type VcsRepo = {
  identifier?: string;
  branch?: string;
  oauthTokenId?: string;
  githubAppInstallationId?: string;
  ingressSubmodules?: boolean;
  tagsRegex?: string;
};

export type VcsWorkspace = {
  id: string;
  attributes: {
    name: string;
    "vcs-repo"?: VcsRepo | null;
    "working-directory"?: string | null;
    "auto-apply"?: boolean;
    "file-triggers-enabled"?: boolean;
    "trigger-prefixes"?: string[];
    "trigger-patterns"?: string[];
    "speculative-enabled"?: boolean;
    permissions?: { "can-update"?: boolean };
    [key: string]: unknown;
  };
};

type GitHubAppInstallation = Readonly<{
  id: string;
  attributes: Readonly<{ name: string }>;
}>;

type OAuthClient = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    "service-provider"?: string;
    "service-provider-display-name"?: string;
  }>;
}>;

type OAuthToken = Readonly<{
  id: string;
  attributes: Readonly<{ "service-provider-user"?: string | null }>;
}>;

export type VcsConnection = Readonly<{
  id: string;
  kind: "github-app" | "oauth-token";
  label: string;
  value: string;
}>;

// oxlint-disable-next-line react/only-export-components -- shared by the create and settings forms without adding a third file
export async function loadOrganizationVcsConnections(
  orgName: string,
  signal?: AbortSignal,
): Promise<VcsConnection[]> {
  const options = signal === undefined ? {} : { signal };
  const [githubResponse, oauthResponse] = await Promise.all([
    fetchApi(`/organizations/${encodeURIComponent(orgName)}/github-app/installations`, options),
    fetchApi(`/organizations/${encodeURIComponent(orgName)}/oauth-clients`, options),
  ]) as [
    { data?: GitHubAppInstallation[] },
    { data?: OAuthClient[] },
  ];
  const installations = Array.isArray(githubResponse.data) ? githubResponse.data : [];
  const clients = Array.isArray(oauthResponse.data) ? oauthResponse.data : [];
  const oauthConnections = await Promise.all(clients.map(async (client: OAuthClient): Promise<VcsConnection[]> => {
    const response = await fetchApi(`/oauth-clients/${encodeURIComponent(client.id)}/oauth-tokens`, options) as {
      data?: OAuthToken[];
    };
    const tokens = Array.isArray(response.data) ? response.data : [];
    const provider = client.attributes["service-provider-display-name"]
      ?? client.attributes["service-provider"]
      ?? "OAuth";
    return tokens.map((token: OAuthToken): VcsConnection => {
      const user = token.attributes["service-provider-user"];
      return {
        id: token.id,
        kind: "oauth-token",
        label: `${client.attributes.name} — ${provider}${typeof user === "string" && user !== "" ? ` (${user})` : ""}`,
        value: `oauth-token:${token.id}`,
      };
    });
  }));
  return [
    ...installations.map((installation: GitHubAppInstallation): VcsConnection => ({
      id: installation.id,
      kind: "github-app",
      label: `${installation.attributes.name} — GitHub App`,
      value: `github-app:${installation.id}`,
    })),
    ...oauthConnections.flat(),
  ];
}

const entries = (value: string): string[] =>
  value.split(/[\r\n,]+/).map((entry: string): string => entry.trim()).filter(Boolean);

export function WorkspaceVcs({
  workspace,
  onSaved,
}: Readonly<{
  workspace: VcsWorkspace;
  onSaved: (workspace: VcsWorkspace) => void;
}>): React.JSX.Element {
  const { orgName = "" } = useParams<{ orgName?: string }>();
  const initialRepo = workspace.attributes["vcs-repo"] ?? null;
  const initialConnection: VcsConnection | null = initialRepo?.githubAppInstallationId != null
    ? {
        id: initialRepo.githubAppInstallationId,
        kind: "github-app",
        label: "Current GitHub App connection",
        value: `github-app:${initialRepo.githubAppInstallationId}`,
      }
    : initialRepo?.oauthTokenId != null
      ? {
          id: initialRepo.oauthTokenId,
          kind: "oauth-token",
          label: "Current OAuth connection",
          value: `oauth-token:${initialRepo.oauthTokenId}`,
        }
      : null;
  const [connected, setConnected] = useState(initialRepo !== null);
  const [identifier, setIdentifier] = useState(initialRepo?.identifier ?? "");
  const [branch, setBranch] = useState(initialRepo?.branch ?? "");
  const [connectionValue, setConnectionValue] = useState(initialConnection?.value ?? "");
  const [connections, setConnections] = useState<VcsConnection[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [connectionsError, setConnectionsError] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState(
    workspace.attributes["working-directory"] ?? "",
  );
  const [tagsRegex, setTagsRegex] = useState(initialRepo?.tagsRegex ?? "");
  const [triggerPrefixes, setTriggerPrefixes] = useState(
    (workspace.attributes["trigger-prefixes"] ?? []).join(", "),
  );
  const [triggerPatterns, setTriggerPatterns] = useState(
    (workspace.attributes["trigger-patterns"] ?? []).join(", "),
  );
  const [ingressSubmodules, setIngressSubmodules] = useState(
    initialRepo?.ingressSubmodules === true,
  );
  const [autoApply, setAutoApply] = useState(workspace.attributes["auto-apply"] === true);
  const [fileTriggersEnabled, setFileTriggersEnabled] = useState(
    workspace.attributes["file-triggers-enabled"] !== false,
  );
  const [speculativeEnabled, setSpeculativeEnabled] = useState(
    workspace.attributes["speculative-enabled"] !== false,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const canUpdate = workspace.attributes.permissions?.["can-update"] === true;
  const displayedConnections = initialConnection !== null
    && !connections.some((connection: VcsConnection): boolean => connection.value === initialConnection.value)
    ? [initialConnection, ...connections]
    : connections;

  useEffect((): (() => void) | undefined => {
    if (!canUpdate || orgName === "") return undefined;
    const controller = new AbortController();
    setConnectionsLoading(true);
    setConnectionsError("");
    void loadOrganizationVcsConnections(orgName, controller.signal)
      .then((loaded: VcsConnection[]): void => {
        if (!controller.signal.aborted) setConnections(loaded);
      })
      .catch((caught: unknown): void => {
        if (!controller.signal.aborted) {
          setConnectionsError(
            caught instanceof Error ? caught.message : "Registered VCS connections could not be loaded.",
          );
        }
      })
      .finally((): void => {
        if (!controller.signal.aborted) setConnectionsLoading(false);
      });
    return (): void => {
      controller.abort();
    };
  }, [canUpdate, orgName]);

  const save = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!canUpdate) return;
    const normalizedIdentifier = identifier.trim();
    const selectedConnection = displayedConnections.find(
      (connection: VcsConnection): boolean => connection.value === connectionValue,
    );
    if (normalizedIdentifier === "") {
      setError("Repository identifier is required.");
      return;
    }
    if (selectedConnection === undefined) {
      setError("Select a registered VCS connection.");
      return;
    }

    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const response = await fetchApi(`/workspaces/${workspace.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            id: workspace.id,
            type: "workspaces",
            attributes: {
              "vcs-repo": {
                identifier: normalizedIdentifier,
                branch: branch.trim() === "" ? null : branch.trim(),
                "github-app-installation-id": selectedConnection.kind === "github-app"
                  ? selectedConnection.id
                  : null,
                "oauth-token-id": selectedConnection.kind === "oauth-token"
                  ? selectedConnection.id
                  : null,
                "ingress-submodules": ingressSubmodules,
                "tags-regex": tagsRegex.trim() === "" ? null : tagsRegex.trim(),
              },
              "working-directory": workingDirectory.trim(),
              "auto-apply": autoApply,
              "file-triggers-enabled": fileTriggersEnabled,
              "trigger-prefixes": entries(triggerPrefixes),
              "trigger-patterns": entries(triggerPatterns),
              "speculative-enabled": speculativeEnabled,
            },
          },
        }),
      }) as { data: VcsWorkspace };
      onSaved(response.data);
      setConnected(true);
      setSaved(true);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Failed to save VCS settings");
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    if (!canUpdate || !window.confirm("Disconnect this workspace from version control?")) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const response = await fetchApi(`/workspaces/${workspace.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            id: workspace.id,
            type: "workspaces",
            attributes: { "vcs-repo": null },
          },
        }),
      }) as { data: VcsWorkspace };
      onSaved(response.data);
      setConnected(false);
      setSaved(true);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Failed to disconnect VCS");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="max-w-4xl">
      <Card>
        <CardHeader>
          <CardTitle>Version control</CardTitle>
          <CardAction>
            <Badge variant={connected ? "default" : "secondary"}>
              {connected ? "Connected" : "Not connected"}
            </Badge>
          </CardAction>
          <CardDescription>
            Configure the repository source and the changes that trigger workspace runs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-disabled={!canUpdate}>
              <FieldLabel htmlFor="vcs-identifier">Repository identifier</FieldLabel>
              <Input
                id="vcs-identifier"
                value={identifier}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                  setIdentifier(event.target.value);
                }}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                  setIdentifier(event.currentTarget.value);
                }}
                placeholder="organization/repository"
                disabled={!canUpdate}
              />
              <FieldDescription>The namespace and repository that contains this configuration.</FieldDescription>
            </Field>
            <Field data-disabled={!canUpdate}>
              <FieldLabel htmlFor="vcs-connection">VCS connection</FieldLabel>
              <Select
                id="vcs-connection"
                value={connectionValue}
                onValueChange={setConnectionValue}
                disabled={!canUpdate || connectionsLoading}
              >
                <SelectItem value="">
                  {connectionsLoading ? "Loading registered connections…" : "Select a registered connection"}
                </SelectItem>
                {displayedConnections.map((connection: VcsConnection): React.JSX.Element => (
                  <SelectItem key={connection.value} value={connection.value}>
                    {connection.label}
                  </SelectItem>
                ))}
              </Select>
              {connectionsError !== "" ? (
                <p role="alert" className="text-sm text-destructive">
                  Registered VCS connections could not be loaded. The current connection can still be preserved.
                </p>
              ) : (
                <FieldDescription>
                  {displayedConnections.length === 0 && !connectionsLoading
                    ? "No registered connections are available. Add one in organization VCS settings."
                    : "Choose a registered GitHub App or OAuth connection."}
                </FieldDescription>
              )}
            </Field>
            <FieldGroup className="grid gap-5 @md/field-group:grid-cols-2">
              <Field data-disabled={!canUpdate}>
                <FieldLabel htmlFor="vcs-branch">VCS branch</FieldLabel>
                <Input
                  id="vcs-branch"
                  value={branch}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                    setBranch(event.target.value);
                  }}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                    setBranch(event.currentTarget.value);
                  }}
                  placeholder="Default branch"
                  disabled={!canUpdate}
                />
              </Field>
              <Field data-disabled={!canUpdate}>
                <FieldLabel htmlFor="vcs-working-directory">Terraform working directory</FieldLabel>
                <Input
                  id="vcs-working-directory"
                  value={workingDirectory}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                    setWorkingDirectory(event.target.value);
                  }}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                    setWorkingDirectory(event.currentTarget.value);
                  }}
                  placeholder="Root of repository"
                  disabled={!canUpdate}
                />
              </Field>
            </FieldGroup>
            <Field data-disabled={!canUpdate}>
              <FieldLabel htmlFor="vcs-tags-regex">Git tag regular expression</FieldLabel>
              <Input
                id="vcs-tags-regex"
                value={tagsRegex}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                  setTagsRegex(event.target.value);
                }}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                  setTagsRegex(event.currentTarget.value);
                }}
                placeholder="^v\d+\.\d+\.\d+$"
                disabled={!canUpdate}
              />
              <FieldDescription>When set, matching tags trigger runs regardless of the branch.</FieldDescription>
            </Field>
            <FieldGroup className="grid gap-5 @md/field-group:grid-cols-2">
              <Field data-disabled={!canUpdate}>
                <FieldLabel htmlFor="vcs-trigger-prefixes">Trigger prefixes</FieldLabel>
                <Input
                  id="vcs-trigger-prefixes"
                  value={triggerPrefixes}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                    setTriggerPrefixes(event.target.value);
                  }}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                    setTriggerPrefixes(event.currentTarget.value);
                  }}
                  placeholder="modules, services/api"
                  disabled={!canUpdate}
                />
                <FieldDescription>Separate repository paths with commas.</FieldDescription>
              </Field>
              <Field data-disabled={!canUpdate}>
                <FieldLabel htmlFor="vcs-trigger-patterns">Trigger patterns</FieldLabel>
                <Input
                  id="vcs-trigger-patterns"
                  value={triggerPatterns}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                    setTriggerPatterns(event.target.value);
                  }}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                    setTriggerPatterns(event.currentTarget.value);
                  }}
                  placeholder="modules/**/*.tf, shared/**/*.tf"
                  disabled={!canUpdate}
                />
                <FieldDescription>Separate glob patterns with commas.</FieldDescription>
              </Field>
            </FieldGroup>
            <FieldSet disabled={!canUpdate}>
              <FieldLegend variant="label">Run behavior</FieldLegend>
              <FieldGroup className="gap-3">
                <Field orientation="horizontal" data-disabled={!canUpdate}>
                  <Checkbox
                    id="vcs-file-triggers"
                    checked={fileTriggersEnabled}
                    onCheckedChange={(checked: boolean): void => { setFileTriggersEnabled(checked); }}
                    disabled={!canUpdate}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="vcs-file-triggers">Filter runs by changed files</FieldLabel>
                    <FieldDescription>Use the configured paths and patterns to decide when to run.</FieldDescription>
                  </FieldContent>
                </Field>
                <Field orientation="horizontal" data-disabled={!canUpdate}>
                  <Checkbox
                    id="vcs-speculative"
                    checked={speculativeEnabled}
                    onCheckedChange={(checked: boolean): void => { setSpeculativeEnabled(checked); }}
                    disabled={!canUpdate}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="vcs-speculative">Automatic speculative plans</FieldLabel>
                    <FieldDescription>Plan pull requests before they are merged.</FieldDescription>
                  </FieldContent>
                </Field>
                <Field orientation="horizontal" data-disabled={!canUpdate}>
                  <Checkbox
                    id="vcs-auto-apply"
                    checked={autoApply}
                    onCheckedChange={(checked: boolean): void => { setAutoApply(checked); }}
                    disabled={!canUpdate}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="vcs-auto-apply">Auto-apply successful plans</FieldLabel>
                    <FieldDescription>Apply VCS runs without waiting for manual confirmation.</FieldDescription>
                  </FieldContent>
                </Field>
                <Field orientation="horizontal" data-disabled={!canUpdate}>
                  <Checkbox
                    id="vcs-submodules"
                    checked={ingressSubmodules}
                    onCheckedChange={(checked: boolean): void => { setIngressSubmodules(checked); }}
                    disabled={!canUpdate}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="vcs-submodules">Include submodules when cloning</FieldLabel>
                    <FieldDescription>Recursively fetch Git submodules with the repository.</FieldDescription>
                  </FieldContent>
                </Field>
              </FieldGroup>
            </FieldSet>
            <FieldError>{error}</FieldError>
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-between">
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="destructive"
              onClick={(): void => { void disconnect(); }}
              disabled={!connected || saving || !canUpdate}
            >
              Disconnect
            </Button>
            <span role="status" className="text-sm text-muted-foreground">
              {saved ? "VCS settings saved." : canUpdate ? "" : "You cannot update this workspace."}
            </span>
          </div>
          <Button type="submit" disabled={saving || !canUpdate}>
            {saving && <Spinner data-icon="inline-start" />}
            {saving ? "Saving" : connected ? "Save VCS settings" : "Connect repository"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
