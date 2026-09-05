import { useEffect, useState } from "react";
import type { JsonValue } from "../lib/json";
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
import { VcsRepoSelector } from "@/components/VcsRepoSelector";
import { fetchApi } from "@/lib/api";
import { isString } from "../lib/type-guards";

type VcsRepo = {
  identifier?: string | null;
  branch?: string | null;
  "oauth-token-id"?: string | null;
  "github-app-installation-id"?: string | null;
  "ingress-submodules"?: boolean | null;
  "tags-regex"?: string | null;
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
    [key: string]: JsonValue;
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

export const REGISTRY_SUPPORTED_VCS_PROVIDERS = ["github", "github_enterprise"] as const;

// oxlint-disable-next-line react/only-export-components -- shared by the create and settings forms without adding a third file
export async function loadOrganizationVcsConnections(
  orgName: string,
  signal?: AbortSignal,
  options?: Readonly<{ supportedProviders?: readonly string[] }>,
): Promise<VcsConnection[]> {
  const requestOptions = signal === undefined ? {} : { signal };
  // SAFETY: both endpoints return the JSON:API envelope per contract.
  const [githubResponse, oauthResponse] = await Promise.all([
    fetchApi(`/organizations/${encodeURIComponent(orgName)}/github-app/installations`, requestOptions),
    fetchApi(`/organizations/${encodeURIComponent(orgName)}/oauth-clients`, requestOptions),
  ]) as [
    { data?: GitHubAppInstallation[] },
    { data?: OAuthClient[] },
  ];
  const installations = Array.isArray(githubResponse.data) ? githubResponse.data : [];
  const clients = (Array.isArray(oauthResponse.data) ? oauthResponse.data : [])
    .filter((client): boolean => options?.supportedProviders === undefined || options.supportedProviders.includes(client.attributes["service-provider"] ?? ""));
  const oauthConnections = await Promise.all(clients.map(async (client: OAuthClient): Promise<VcsConnection[]> => {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
    const response = await fetchApi(`/oauth-clients/${encodeURIComponent(client.id)}/oauth-tokens`, requestOptions) as {
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
        label: `${client.attributes.name} — ${provider}${isString(user) && user !== "" ? ` (${user})` : ""}`,
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
  const initialConnection: VcsConnection | null = initialRepo?.["github-app-installation-id"] != null
    ? {
        id: initialRepo["github-app-installation-id"],
        kind: "github-app",
        label: "Current GitHub App connection",
        value: `github-app:${initialRepo["github-app-installation-id"]}`,
      }
    : initialRepo?.["oauth-token-id"] != null
      ? {
          id: initialRepo["oauth-token-id"],
          kind: "oauth-token",
          label: "Current OAuth connection",
          value: `oauth-token:${initialRepo["oauth-token-id"]}`,
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
  const [tagsRegex, setTagsRegex] = useState(initialRepo?.["tags-regex"] ?? "");
  const [triggerPrefixes, setTriggerPrefixes] = useState(
    (workspace.attributes["trigger-prefixes"] ?? []).join(", "),
  );
  const [triggerPatterns, setTriggerPatterns] = useState(
    (workspace.attributes["trigger-patterns"] ?? []).join(", "),
  );
  const [ingressSubmodules, setIngressSubmodules] = useState(
    initialRepo?.["ingress-submodules"] === true,
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

  const [vcsRepositories, setVcsRepositories] = useState<{ identifier: string; name: string; owner?: string }[]>([]);
  const [vcsRepositoriesLoading, setVcsRepositoriesLoading] = useState(false);

  useEffect((): (() => void) | undefined => {
    setVcsRepositories([]);
    setVcsRepositoriesLoading(false);
    if (!canUpdate || orgName === "" || connectionValue === "") return undefined;
    const controller = new AbortController();
    setVcsRepositoriesLoading(true);
    void fetchApi<{ data?: { attributes: { identifier: string; name: string; owner?: string } }[] }>(
      `/organizations/${encodeURIComponent(orgName)}/vcs-connections/${encodeURIComponent(connectionValue)}/repositories`,
      { signal: controller.signal },
    )
      .then((res): void => {
        if (controller.signal.aborted) return;
        const list = res.data;
        if (Array.isArray(list)) setVcsRepositories(list.map((item) => item.attributes));
      })
      .catch((): void => {})
      .finally((): void => { if (!controller.signal.aborted) setVcsRepositoriesLoading(false); });
    return (): void => {
      controller.abort();
    };
  }, [canUpdate, connectionValue, orgName]);

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
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
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
    if (!canUpdate) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
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
    <form onSubmit={save}>
      <Card>
        <CardHeader>
          <CardTitle>Repository connection</CardTitle>
          <CardAction>
            <Badge variant={connected ? "success" : "secondary"}>
              {connected ? "Connected" : "Not connected"}
            </Badge>
          </CardAction>
          <CardDescription>
            Configure the repository source and the changes that trigger workspace runs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <FieldGroup>
            <FieldSet disabled={!canUpdate}>
              <FieldLegend variant="label">Repository source</FieldLegend>
              <FieldGroup className="gap-4">
                <Field data-disabled={!canUpdate}>
                  <FieldLabel htmlFor="vcs-connection">VCS connection</FieldLabel>
                  <Select
                    id="vcs-connection"
                    name="vcs-connection"
                    value={connectionValue}
                    onValueChange={(val: string): void => {
                      setConnectionValue(val);
                    }}
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

                <Field data-disabled={!canUpdate}>
                  <FieldLabel htmlFor="vcs-identifier">Repository identifier</FieldLabel>
                  <VcsRepoSelector
                    id="vcs-identifier"
                    name="vcs-repository"
                    value={identifier}
                    onValueChange={setIdentifier}
                    repositories={vcsRepositories}
                    loading={vcsRepositoriesLoading}
                    disabled={!canUpdate}
                    placeholder="e.g. organization/repository"
                  />
                  <FieldDescription>Search by organization or repository name, then select the full repository path.</FieldDescription>
                </Field>

                <FieldGroup className="grid gap-5 @md/field-group:grid-cols-2">
                  <Field data-disabled={!canUpdate}>
                    <FieldLabel htmlFor="vcs-branch">VCS branch</FieldLabel>
                    <Input
                      id="vcs-branch"
                      name="vcs-branch"
                      autoComplete="off"
                      spellCheck={false}
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
                    <FieldLabel htmlFor="vcs-working-directory">{workspace.attributes["iac-binary"] === "tofu" ? "OpenTofu" : "Terraform"} working directory</FieldLabel>
                    <Input
                      id="vcs-working-directory"
                      name="vcs-working-directory"
                      autoComplete="off"
                      spellCheck={false}
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
              </FieldGroup>
            </FieldSet>

            <FieldSet disabled={!canUpdate} className="border-t border-border/60 pt-5">
              <FieldLegend variant="label">Run triggers</FieldLegend>
              <FieldGroup className="gap-4">
                <Field data-disabled={!canUpdate}>
                  <FieldLabel htmlFor="vcs-tags-regex">Git tag regular expression</FieldLabel>
                  <Input
                    id="vcs-tags-regex"
                    name="vcs-tags-regex"
                    autoComplete="off"
                    spellCheck={false}
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
                  <FieldDescription>
                    {tagsRegex.trim() !== ""
                      ? "Tag triggering active: only matching Git tag pushes will trigger runs; branch pushes and pull requests are ignored."
                      : "Leave blank to trigger from branch pushes and pull requests. When set, only matching Git tag pushes trigger runs."}
                  </FieldDescription>
                </Field>

                <Field orientation="horizontal" data-disabled={!canUpdate}>
                  <Checkbox
                    id="vcs-file-triggers"
                    checked={fileTriggersEnabled}
                    onCheckedChange={(checked: boolean): void => { setFileTriggersEnabled(checked); }}
                    disabled={!canUpdate}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="vcs-file-triggers">Filter runs by changed files</FieldLabel>
                    <FieldDescription>Only trigger runs when changes match the prefixes or glob patterns below.</FieldDescription>
                  </FieldContent>
                </Field>

                {fileTriggersEnabled && (
                  <FieldGroup className="grid gap-5 pl-7 @md/field-group:grid-cols-2">
                    <Field data-disabled={!canUpdate}>
                      <FieldLabel htmlFor="vcs-trigger-prefixes">Trigger prefixes</FieldLabel>
                      <Input
                        id="vcs-trigger-prefixes"
                        name="vcs-trigger-prefixes"
                        autoComplete="off"
                        spellCheck={false}
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
                        name="vcs-trigger-patterns"
                        autoComplete="off"
                        spellCheck={false}
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
                      <FieldDescription>Separate glob patterns with commas. Entries must be non-blank; a pattern that matches no changed files never triggers a run.</FieldDescription>
                    </Field>
                  </FieldGroup>
                )}
              </FieldGroup>
            </FieldSet>

            <FieldSet disabled={!canUpdate} className="border-t border-border/60 pt-5">
              <FieldLegend variant="label">Run behavior</FieldLegend>
              <FieldGroup className="gap-3">
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
            {saving ? "Saving…" : connected ? "Save VCS settings" : "Connect repository"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
