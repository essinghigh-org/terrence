import { Select } from "../components/ui/select";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { RefObject } from "react";
import {
  AzureDevOpsCredentialFields,
  AzureDevOpsHookDialog,
  AzureDevOpsPatDialog,
  azureDevOpsSaveError,
  clearAzureDevOpsCredentials,
  takeAzureDevOpsCredentials,
} from "../components/AzureDevOpsConnection";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../components/ui/dialog";
import { Badge } from "../components/ui/badge";
import { Spinner } from "../components/ui/spinner";
import { CheckCircle, ExternalLink, GitBranch, Plus, Trash2, Unplug } from "lucide-react";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { EmptyState } from "../components/EmptyState";
import { PageHeader, PageShell } from "../components/PageHeader";
import { isString } from "../lib/type-guards";

type OAuthClient = Readonly<{
  readonly id: string;
  readonly attributes: Readonly<{
    readonly name: string;
    readonly "service-provider": string;
    readonly "http-url"?: string;
    readonly "api-url"?: string;
    readonly "ado-org-name"?: string | null;
    readonly "connect-path"?: string;
  }>;
  readonly relationships?: Readonly<{
    readonly "oauth-tokens"?: Readonly<{
      readonly links?: Readonly<{ readonly related?: string }>;
    }>;
  }>;
}>;

type OAuthToken = Readonly<{
  readonly id: string;
  readonly attributes: Readonly<{
    readonly "service-provider-user"?: string | null;
  }>;
}>;

type GitHubAppInstallation = Readonly<{
  readonly id: string;
  readonly attributes: Readonly<{
    readonly name: string;
    readonly "installation-id": number;
    readonly "icon-url": string | null;
    readonly "installation-type": string | null;
    readonly "installation-url": string | null;
  }>;
}>;

type AuthorizationDocument = Readonly<{
  readonly data?: Readonly<{
    readonly attributes?: Readonly<{ readonly "authorization-url"?: unknown }>;
  }>;
}>;

const providerDefaults = {
  github: {
    httpUrl: "https://github.com",
    apiUrl: "https://api.github.com",
  },
  github_enterprise: {
    httpUrl: "",
    apiUrl: "",
  },
  gitlab: {
    httpUrl: "https://gitlab.com",
    apiUrl: "https://gitlab.com/api/v4",
  },
  bitbucket: {
    httpUrl: "https://bitbucket.org",
    apiUrl: "https://api.bitbucket.org/2.0",
  },
  ado_services: {
    httpUrl: "https://dev.azure.com",
    apiUrl: "https://dev.azure.com",
  },
} as const;

type ServiceProvider = keyof typeof providerDefaults;
type VcsAccess = "allowed" | "denied" | "error";

function hasOAuthToken(tokensByClient: Readonly<Record<string, readonly OAuthToken[]>>, clientId: string): boolean {
  return (tokensByClient[clientId]?.length ?? 0) > 0;
}

function createProviderAttributes(
  input: Readonly<{
    name: string;
    serviceProvider: ServiceProvider;
    httpUrl: string;
    apiUrl: string;
    key: string;
    secret: string;
    adoOrgName: string;
    patRef: RefObject<HTMLInputElement | null>;
    webhookSecretRef: RefObject<HTMLInputElement | null>;
  }>,
): Readonly<Record<string, string>> {
  if (input.httpUrl.trim() === "" || input.apiUrl.trim() === "") {
    clearAzureDevOpsCredentials(input);
    throw new Error("HTTP URL and API URL are required.");
  }
  const azureDevOps = input.serviceProvider === "ado_services";
  const credentials = azureDevOps
    ? takeAzureDevOpsCredentials(input.adoOrgName, input, true)
    : { key: input.key.trim(), secret: input.secret.trim() };
  return {
    name: input.name.trim() !== "" ? input.name.trim() : `${input.serviceProvider.toUpperCase()} Provider`,
    "service-provider": input.serviceProvider,
    "http-url": azureDevOps ? providerDefaults.ado_services.httpUrl : input.httpUrl.trim(),
    "api-url": azureDevOps ? providerDefaults.ado_services.apiUrl : input.apiUrl.trim(),
    ...credentials,
  };
}

function isAzureDevOpsServerClient(client: OAuthClient): boolean {
  return ["ado_server", "azure_devops_server"].includes(client.attributes["service-provider"]);
}

function AzureDevOpsUnavailable({ client }: Readonly<{ client: OAuthClient }>): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Badge variant="outline">Repository integration unavailable</Badge>
      <p className="max-w-xs text-xs text-muted-foreground">
        This OAuth client is stored for API compatibility. Azure DevOps Server repository fetching, webhooks and run
        statuses are not implemented yet.
      </p>
      {isString(client.attributes["ado-org-name"]) && client.attributes["ado-org-name"] !== "" && (
        <p className="text-xs text-muted-foreground">Organization: {client.attributes["ado-org-name"]}</p>
      )}
    </div>
  );
}

function OAuthConnectionStatus({
  client,
  connected,
  statusKnown,
  providerUser,
}: Readonly<{
  client: OAuthClient;
  connected: boolean;
  statusKnown: boolean;
  providerUser: string | undefined;
}>): React.JSX.Element {
  if (isAzureDevOpsServerClient(client)) return <AzureDevOpsUnavailable client={client} />;
  if (client.attributes["service-provider"] === "ado_services") {
    return (
      <div className="space-y-1">
        <Badge variant={connected ? "secondary" : "outline"}>
          {!statusKnown ? "Status unavailable" : connected ? "PAT configured" : "Not connected"}
        </Badge>
        {connected && <p className="text-xs text-muted-foreground">Live access not verified.</p>}
        <p className="text-xs text-muted-foreground">
          Organization: {client.attributes["ado-org-name"] ?? "Not configured"}
        </p>
      </div>
    );
  }
  const label = !statusKnown
    ? "Status unavailable"
    : connected
      ? providerUser === undefined
        ? "Connected"
        : `Connected as ${providerUser}`
      : "Not connected";
  return (
    <Badge variant={connected ? "secondary" : "outline"}>
      {connected && <CheckCircle data-icon="inline-start" />}
      {label}
    </Badge>
  );
}

function authorizationUrl(payload: AuthorizationDocument): string {
  const rawUrl = payload.data?.attributes?.["authorization-url"];
  if (!isString(rawUrl) || rawUrl === "") throw new Error("The server did not return an authorization URL.");
  let destination: URL;
  try {
    destination = new URL(rawUrl);
  } catch {
    throw new Error("The server returned an invalid authorization URL.");
  }
  if (
    (destination.protocol !== "https:" && destination.protocol !== "http:") ||
    destination.username !== "" ||
    destination.password !== ""
  )
    throw new Error("The server returned an unsafe authorization URL.");
  return destination.toString();
}

function navigateBrowser(url: string): void {
  window.location.assign(url);
}

async function fetchVcsPermission(encodedOrgName: string, signal: AbortSignal): Promise<boolean> {
  // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
  const organizationResponse = (await fetchApi(`/organizations/${encodedOrgName}`, { signal })) as {
    data?: {
      attributes?: {
        permissions?: { "can-manage-vcs-settings"?: boolean };
      };
    };
  };
  return organizationResponse.data?.attributes?.permissions?.["can-manage-vcs-settings"] === true;
}

type InstallationsAndClients = {
  installations: GitHubAppInstallation[];
  clients: OAuthClient[];
  tokensByClient: Record<string, readonly OAuthToken[]>;
  errors: string[];
};

async function loadInstallationsAndClients(
  encodedOrgName: string,
  signal: AbortSignal,
): Promise<InstallationsAndClients> {
  const [installationResult, clientResult] = await Promise.allSettled([
    fetchApi(`/organizations/${encodedOrgName}/github-app/installations`, { signal }),
    fetchApi(`/organizations/${encodedOrgName}/oauth-clients`, { signal }),
  ]);
  const errors: string[] = [];
  let installations: GitHubAppInstallation[] = [];
  if (installationResult.status === "fulfilled") {
    // SAFETY: the fixture matches the JSON:API envelope the component consumes.
    const data = (installationResult.value as { data?: GitHubAppInstallation[] }).data;
    installations = Array.isArray(data) ? data : [];
  } else {
    errors.push("Failed to load GitHub App installations.");
  }
  let clients: OAuthClient[] = [];
  let tokensByClient: Record<string, readonly OAuthToken[]> = {};
  if (clientResult.status === "rejected") {
    errors.push("Failed to load OAuth clients.");
  } else {
    // SAFETY: the fixture matches the JSON:API envelope the component consumes.
    const data = (clientResult.value as { data?: OAuthClient[] }).data;
    clients = Array.isArray(data) ? data : [];
    const tokenResults = await Promise.allSettled(
      clients.map(async (client): Promise<readonly [string, readonly OAuthToken[]]> => {
        const related = client.relationships?.["oauth-tokens"]?.links?.related;
        // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
        const response = (await fetchApi(related ?? `/oauth-clients/${encodeURIComponent(client.id)}/oauth-tokens`, {
          signal,
        })) as { data?: OAuthToken[] };
        return [client.id, Array.isArray(response.data) ? response.data : []] as const;
      }),
    );
    tokensByClient = Object.fromEntries(
      tokenResults
        .filter(
          (result): result is PromiseFulfilledResult<readonly [string, readonly OAuthToken[]]> =>
            result.status === "fulfilled",
        )
        .map((result): readonly [string, readonly OAuthToken[]] => result.value),
    );
    if (tokenResults.some((result): boolean => result.status === "rejected")) {
      errors.push("Some OAuth connection statuses could not be loaded.");
    }
  }
  return { installations, clients, tokensByClient, errors };
}

function GitHubAppsSection({
  loading,
  ghApps,
  startingGitHubSetup,
  onSetup,
  onUninstall,
  onRemove,
}: Readonly<{
  loading: boolean;
  ghApps: readonly GitHubAppInstallation[];
  startingGitHubSetup: boolean;
  onSetup: () => void;
  onUninstall: (app: GitHubAppInstallation) => void;
  onRemove: (app: GitHubAppInstallation) => void;
}>): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-heading text-xl font-semibold">GitHub App installations</h2>
          <p className="text-sm text-muted-foreground">Manage your Terrence GitHub App installations.</p>
        </div>
        <Button disabled={startingGitHubSetup} onClick={onSetup}>
          {startingGitHubSetup ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
          {startingGitHubSetup ? "Opening GitHub…" : "Install GitHub App"}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Installation ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center">
                    <Spinner className="mx-auto size-6 text-primary" />
                  </TableCell>
                </TableRow>
              ) : ghApps.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                    No GitHub App installations registered.
                  </TableCell>
                </TableRow>
              ) : (
                ghApps.map(
                  (app: GitHubAppInstallation): React.JSX.Element => (
                    <TableRow key={app.id}>
                      <TableCell className="font-medium flex items-center gap-2">
                        {isString(app.attributes["icon-url"]) && app.attributes["icon-url"] !== "" && (
                          <img src={app.attributes["icon-url"]} className="size-6 rounded-full" alt="" />
                        )}
                        {app.attributes.name}
                      </TableCell>
                      <TableCell>{app.attributes["installation-id"]}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{app.attributes["installation-type"] ?? "Organization"}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          <CheckCircle data-icon="inline-start" />
                          Connected
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(): void => {
                                onUninstall(app);
                              }}
                            >
                              <Unplug data-icon="inline-start" />
                              Uninstall
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={(): void => {
                                onRemove(app);
                              }}
                            >
                              <Trash2 data-icon="inline-start" />
                              Remove
                            </Button>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  ),
                )
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function OAuthClientsSection({
  loading,
  clients,
  tokensByClient,
  connectingClientId,
  onConnect,
  onManagePat,
  onHookSetup,
  onDeleteRequest,
  onAdd,
}: Readonly<{
  loading: boolean;
  clients: readonly OAuthClient[];
  tokensByClient: Readonly<Record<string, readonly OAuthToken[]>>;
  connectingClientId: string;
  onConnect: (client: OAuthClient) => void;
  onManagePat: (client: OAuthClient) => void;
  onHookSetup: (client: OAuthClient) => void;
  onDeleteRequest: (client: OAuthClient) => void;
  onAdd: () => void;
}>): React.JSX.Element {
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-heading text-xl font-semibold">VCS provider connections</h2>
          <p className="text-sm text-muted-foreground">
            OAuth applications and Azure DevOps Services personal access tokens.
          </p>
        </div>
        <Button onClick={onAdd}>
          <Plus className="mr-1.5 size-4" /> Add VCS Provider
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider / Name</TableHead>
                <TableHead>Service Provider</TableHead>
                <TableHead>HTTP URL</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center">
                    <Spinner className="mx-auto size-6 text-primary" />
                  </TableCell>
                </TableRow>
              ) : clients.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                    <GitBranch className="mx-auto mb-2 size-8 text-muted-foreground/60" />
                    No VCS Providers connected. Connect a VCS provider to trigger workspace runs from git commits.
                  </TableCell>
                </TableRow>
              ) : (
                clients.map((client: OAuthClient): React.JSX.Element => {
                  const statusKnown = Object.prototype.hasOwnProperty.call(tokensByClient, client.id);
                  const tokens = tokensByClient[client.id] ?? [];
                  const unsupportedServer = isAzureDevOpsServerClient(client);
                  const azureDevOps = client.attributes["service-provider"] === "ado_services";
                  const connected = !unsupportedServer && statusKnown && tokens.length > 0;
                  const providerUser = tokens
                    .map((token): string | null | undefined => token.attributes["service-provider-user"])
                    .find((value): value is string => isString(value) && value !== "");
                  const connecting = connectingClientId === client.id;
                  return (
                    <TableRow key={client.id}>
                      <TableCell className="font-semibold">
                        <div className="flex items-center gap-2">
                          <GitBranch className="size-4 text-primary" />
                          {client.attributes.name}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize font-mono text-xs">
                          {client.attributes["service-provider"]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground font-mono">
                        {client.attributes["http-url"] ?? "Not configured"}
                      </TableCell>
                      <TableCell>
                        <OAuthConnectionStatus
                          client={client}
                          connected={connected}
                          statusKnown={statusKnown}
                          providerUser={providerUser}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          {!unsupportedServer && !azureDevOps && statusKnown && !connected && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={connecting}
                              onClick={(): void => {
                                onConnect(client);
                              }}
                            >
                              {connecting ? (
                                <Spinner data-icon="inline-start" />
                              ) : (
                                <ExternalLink data-icon="inline-start" />
                              )}
                              {connecting ? "Opening…" : "Connect"}
                            </Button>
                          )}
                          {azureDevOps && statusKnown && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(): void => {
                                onManagePat(client);
                              }}
                            >
                              {connected ? "Rotate PAT" : "Add PAT"}
                            </Button>
                          )}
                          {azureDevOps && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(): void => {
                                onHookSetup(client);
                              }}
                            >
                              Service hook setup
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={(): void => {
                              onDeleteRequest(client);
                            }}
                          >
                            <Trash2 data-icon="inline-start" />
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function CreateProviderDialog({
  open,
  onOpenChange,
  name,
  onNameChange,
  serviceProvider,
  onProviderChange,
  httpUrl,
  onHttpUrlChange,
  apiUrl,
  onApiUrlChange,
  oauthKey,
  onKeyChange,
  secret,
  onSecretChange,
  adoOrgName,
  onAdoOrgNameChange,
  patRef,
  webhookSecretRef,
  formError,
  creating,
  onSubmit,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onNameChange: (value: string) => void;
  serviceProvider: ServiceProvider;
  onProviderChange: (provider: ServiceProvider) => void;
  httpUrl: string;
  onHttpUrlChange: (value: string) => void;
  apiUrl: string;
  onApiUrlChange: (value: string) => void;
  oauthKey: string;
  onKeyChange: (value: string) => void;
  secret: string;
  onSecretChange: (value: string) => void;
  adoOrgName: string;
  onAdoOrgNameChange: (value: string) => void;
  patRef: RefObject<HTMLInputElement | null>;
  webhookSecretRef: RefObject<HTMLInputElement | null>;
  formError: string;
  creating: boolean;
  onSubmit: (e: React.SyntheticEvent) => Promise<void>;
}>): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Add VCS Provider</DialogTitle>
          <DialogDescription>
            Connect with an OAuth app, or an organization-scoped Azure DevOps Services PAT.
          </DialogDescription>
        </DialogHeader>

        {formError !== "" && (
          <div role="alert" className="rounded bg-destructive/15 p-3 text-xs font-medium text-destructive">
            {formError}
          </div>
        )}

        <form
          onSubmit={(e): void => {
            void onSubmit(e);
          }}
          noValidate
          className="space-y-4 py-2"
        >
          <fieldset disabled={creating} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="vcs-name" className="text-sm font-medium">
                Name
              </label>
              <Input
                id="vcs-name"
                name="vcs-integration-name"
                autoComplete="off"
                spellCheck={false}
                value={name}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                  onNameChange(event.target.value);
                }}
                placeholder="GitHub Commercial"
                required
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="vcs-provider" className="text-sm font-medium">
                VCS Type
              </label>
              <Select
                id="vcs-provider"
                name="service-provider"
                value={serviceProvider}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>): void => {
                  // SAFETY: the select options are generated from the same union; the change event carries one of them.
                  const provider = event.target.value as ServiceProvider;
                  onProviderChange(provider);
                }}
              >
                <option value="github">GitHub.com</option>
                <option value="github_enterprise">GitHub Enterprise Server</option>
                <option value="gitlab">GitLab.com / GitLab EE</option>
                <option value="bitbucket">Bitbucket Cloud</option>
                <option value="ado_services">Azure DevOps Services (PAT)</option>
              </Select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="vcs-http-url" className="text-xs font-medium">
                  HTTP URL
                </label>
                <Input
                  id="vcs-http-url"
                  name="http-url"
                  readOnly={serviceProvider === "ado_services"}
                  autoComplete="url"
                  value={httpUrl}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                    onHttpUrlChange(event.target.value);
                  }}
                  placeholder={
                    serviceProvider === "github_enterprise"
                      ? "https://github.example.com"
                      : providerDefaults[serviceProvider].httpUrl
                  }
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="vcs-api-url" className="text-xs font-medium">
                  API URL
                </label>
                <Input
                  id="vcs-api-url"
                  name="api-url"
                  readOnly={serviceProvider === "ado_services"}
                  autoComplete="url"
                  value={apiUrl}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                    onApiUrlChange(event.target.value);
                  }}
                  placeholder={
                    serviceProvider === "github_enterprise"
                      ? "https://github.example.com/api/v3"
                      : providerDefaults[serviceProvider].apiUrl
                  }
                  required
                />
              </div>
            </div>

            {serviceProvider === "ado_services" ? (
              <AzureDevOpsCredentialFields
                organization={adoOrgName}
                onOrganizationChange={onAdoOrgNameChange}
                patRef={patRef}
                webhookSecretRef={webhookSecretRef}
              />
            ) : (
              <>
                <div className="space-y-1.5">
                  <label htmlFor="vcs-key" className="text-sm font-medium">
                    OAuth Application Client ID
                  </label>
                  <Input
                    id="vcs-key"
                    name="client-id"
                    autoComplete="off"
                    spellCheck={false}
                    value={oauthKey}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                      onKeyChange(event.target.value);
                    }}
                    placeholder="Client ID or Application ID"
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="vcs-secret" className="text-sm font-medium">
                    OAuth Client Secret
                  </label>
                  <Input
                    id="vcs-secret"
                    name="client-secret"
                    autoComplete="new-password"
                    type="password"
                    value={secret}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                      onSecretChange(event.target.value);
                    }}
                    placeholder="Client Secret"
                    required
                  />
                </div>
              </>
            )}
          </fieldset>
          <DialogFooter className="pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={(): void => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={creating}>
              {creating && <Spinner data-icon="inline-start" className="size-4" />}
              {creating ? "Connecting VCS provider…" : "Connect VCS Provider"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VcsConfirmDialogs({
  installationToDelete,
  deletingInstallation,
  onClearInstallationToDelete,
  onConfirmDeleteInstallation,
  installationToUninstall,
  uninstallingInstallation,
  onClearInstallationToUninstall,
  onConfirmUninstallInstallation,
  clientToDelete,
  deletingClient,
  onClearClientToDelete,
  onConfirmDeleteClient,
}: Readonly<{
  installationToDelete: GitHubAppInstallation | null;
  deletingInstallation: boolean;
  onClearInstallationToDelete: () => void;
  onConfirmDeleteInstallation: (installation: GitHubAppInstallation) => Promise<void>;
  installationToUninstall: GitHubAppInstallation | null;
  uninstallingInstallation: boolean;
  onClearInstallationToUninstall: () => void;
  onConfirmUninstallInstallation: (installation: GitHubAppInstallation) => Promise<void>;
  clientToDelete: OAuthClient | null;
  deletingClient: boolean;
  onClearClientToDelete: () => void;
  onConfirmDeleteClient: (client: OAuthClient) => Promise<void>;
}>): React.JSX.Element {
  return (
    <>
      <ConfirmDialog
        open={installationToDelete !== null}
        onOpenChange={(open): void => {
          if (!open && !deletingInstallation) onClearInstallationToDelete();
        }}
        title="Remove GitHub App integration"
        description={
          <>
            This removes <strong className="text-foreground">{installationToDelete?.attributes.name}</strong> from
            Terrence. It does not uninstall the GitHub App from GitHub. It cannot be removed while workspaces or policy
            sets use it.
          </>
        }
        confirmText="Remove Integration"
        confirmVariant="destructive"
        requireText={installationToDelete?.attributes.name}
        loading={deletingInstallation}
        onConfirm={async (): Promise<void> => {
          if (installationToDelete !== null) await onConfirmDeleteInstallation(installationToDelete);
        }}
      />

      <ConfirmDialog
        open={installationToUninstall !== null}
        onOpenChange={(open): void => {
          if (!open && !uninstallingInstallation) onClearInstallationToUninstall();
        }}
        title="Uninstall GitHub App installation"
        description={
          <>
            This calls GitHub to uninstall{" "}
            <strong className="text-foreground">{installationToUninstall?.attributes.name}</strong>, then removes that
            installation from Terrence. The site-wide App registration and other installations remain in place.
          </>
        }
        confirmText="Uninstall installation"
        confirmVariant="destructive"
        requireText={installationToUninstall?.attributes.name}
        requireTextLabel={
          installationToUninstall === null
            ? undefined
            : `Type ${installationToUninstall.attributes.name} to confirm the GitHub uninstall.`
        }
        loading={uninstallingInstallation}
        onConfirm={async (): Promise<void> => {
          if (installationToUninstall !== null) await onConfirmUninstallInstallation(installationToUninstall);
        }}
      />

      <ConfirmDialog
        open={clientToDelete !== null}
        onOpenChange={(open): void => {
          if (!open && !deletingClient) onClearClientToDelete();
        }}
        title="Delete VCS Integration"
        description={
          <>
            Are you sure you want to delete VCS client{" "}
            <strong className="text-foreground">{clientToDelete?.attributes.name}</strong>? It cannot be removed while
            workspaces or policy sets use it.
          </>
        }
        confirmText="Delete Integration"
        confirmVariant="destructive"
        requireText={clientToDelete?.attributes.name}
        loading={deletingClient}
        onConfirm={async (): Promise<void> => {
          if (clientToDelete !== null) {
            await onConfirmDeleteClient(clientToDelete);
          }
        }}
      />
    </>
  );
}

export function VcsIntegrations({
  navigateExternal = navigateBrowser,
}: Readonly<{
  navigateExternal?: (url: string) => void;
}> = {}): React.JSX.Element {
  const { orgName } = useParams<{ orgName?: string }>();
  const [clients, setClients] = useState<OAuthClient[]>([]);
  const [oauthTokensByClient, setOauthTokensByClient] = useState<Record<string, readonly OAuthToken[]>>({});
  const [ghApps, setGhApps] = useState<GitHubAppInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connectingClientId, setConnectingClientId] = useState("");
  const [startingGitHubSetup, setStartingGitHubSetup] = useState(false);
  const [installationToDelete, setInstallationToDelete] = useState<GitHubAppInstallation | null>(null);
  const [deletingInstallation, setDeletingInstallation] = useState(false);
  const [installationToUninstall, setInstallationToUninstall] = useState<GitHubAppInstallation | null>(null);
  const [uninstallingInstallation, setUninstallingInstallation] = useState(false);
  const [access, setAccess] = useState<Readonly<{ orgName: string; status: VcsAccess }> | null>(null);
  const loadRequest = useRef<AbortController | null>(null);
  const currentOrgName = orgName ?? "";
  const orgPath = `/app/${encodeURIComponent(currentOrgName)}`;
  const currentOrgNameRef = useRef(currentOrgName);
  currentOrgNameRef.current = currentOrgName;
  const accessStatus: VcsAccess | "loading" = access?.orgName === currentOrgName ? access.status : "loading";
  const canManageVcsSettings = accessStatus === "allowed";

  // Create Modal OAuth
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [serviceProvider, setServiceProvider] = useState<ServiceProvider>("github");
  const [httpUrl, setHttpUrl] = useState<string>(providerDefaults.github.httpUrl);
  const [apiUrl, setApiUrl] = useState<string>(providerDefaults.github.apiUrl);
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");
  const [adoOrgName, setAdoOrgName] = useState("");
  const patRef = useRef<HTMLInputElement>(null);
  const webhookSecretRef = useRef<HTMLInputElement>(null);
  const createRequest = useRef<AbortController | null>(null);
  const [clientToManagePat, setClientToManagePat] = useState<OAuthClient | null>(null);
  const [clientForHookSetup, setClientForHookSetup] = useState<OAuthClient | null>(null);

  const loadIntegrations = useCallback(async (): Promise<void> => {
    loadRequest.current?.abort();
    const controller = new AbortController();
    loadRequest.current = controller;
    const requestIsCurrent = (): boolean => !controller.signal.aborted && loadRequest.current === controller;

    setLoading(true);
    setError("");
    setAccess(null);
    setClients([]);
    setOauthTokensByClient({});
    setGhApps([]);

    try {
      if (currentOrgName === "") throw new Error("Organization not found.");
      const encodedOrgName = encodeURIComponent(currentOrgName);
      const allowed = await fetchVcsPermission(encodedOrgName, controller.signal);
      if (!requestIsCurrent()) return;
      setAccess({ orgName: currentOrgName, status: allowed ? "allowed" : "denied" });
      if (!allowed) return;

      const loaded = await loadInstallationsAndClients(encodedOrgName, controller.signal);
      if (!requestIsCurrent()) return;
      setGhApps(loaded.installations);
      setClients(loaded.clients);
      setOauthTokensByClient(loaded.tokensByClient);
      setError(loaded.errors.join(" "));
    } catch (caught: unknown) {
      if (!requestIsCurrent()) return;
      setAccess({ orgName: currentOrgName, status: "error" });
      setError(caught instanceof Error ? caught.message : "Failed to load VCS permissions.");
    } finally {
      if (requestIsCurrent()) {
        loadRequest.current = null;
        setLoading(false);
      }
    }
  }, [currentOrgName]);

  useEffect((): (() => void) => {
    setDialogOpen(false);
    setClientToManagePat(null);
    setClientForHookSetup(null);
    setAdoOrgName("");
    clearAzureDevOpsCredentials({ patRef, webhookSecretRef });
    createRequest.current?.abort();
    createRequest.current = null;
    setFormError("");
    setConnectingClientId("");
    setStartingGitHubSetup(false);
    setInstallationToDelete(null);
    setDeletingInstallation(false);
    setInstallationToUninstall(null);
    setUninstallingInstallation(false);
    setCreating(false);
    setName("");
    setServiceProvider("github");
    setHttpUrl(providerDefaults.github.httpUrl);
    setApiUrl(providerDefaults.github.apiUrl);
    setKey("");
    setSecret("");
    void loadIntegrations();
    return (): void => {
      loadRequest.current?.abort();
      createRequest.current?.abort();
    };
  }, [loadIntegrations]);

  const requestAuthorization = async (endpoint: string): Promise<string> => {
    // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
    const response = (await fetchApi(endpoint, {
      headers: { Accept: "application/vnd.api+json" },
    })) as AuthorizationDocument;
    return authorizationUrl(response);
  };

  const handleConnect = async (client: OAuthClient): Promise<void> => {
    if (
      !canManageVcsSettings ||
      client.attributes["service-provider"] === "ado_services" ||
      isAzureDevOpsServerClient(client)
    )
      return;
    const actionOrgName = currentOrgName;
    setConnectingClientId(client.id);
    setError("");
    try {
      const connectPath =
        client.attributes["connect-path"] ?? `/oauth-clients/${encodeURIComponent(client.id)}/connect`;
      const destination = await requestAuthorization(connectPath);
      if (currentOrgNameRef.current === actionOrgName) navigateExternal(destination);
    } catch (caught: unknown) {
      if (currentOrgNameRef.current === actionOrgName) {
        setError(caught instanceof Error ? caught.message : "Failed to start VCS authorization.");
      }
    } finally {
      if (currentOrgNameRef.current === actionOrgName) setConnectingClientId("");
    }
  };

  const handleGitHubSetup = async (): Promise<void> => {
    if (!canManageVcsSettings || currentOrgName === "") return;
    const actionOrgName = currentOrgName;
    setStartingGitHubSetup(true);
    setError("");
    try {
      const endpoint = `/organizations/${encodeURIComponent(actionOrgName)}/github-app/installations/setup`;
      const destination = await requestAuthorization(endpoint);
      if (currentOrgNameRef.current === actionOrgName) navigateExternal(destination);
    } catch (caught: unknown) {
      if (currentOrgNameRef.current === actionOrgName) {
        setError(caught instanceof Error ? caught.message : "Failed to start GitHub App setup.");
      }
    } finally {
      if (currentOrgNameRef.current === actionOrgName) setStartingGitHubSetup(false);
    }
  };

  const handleDeleteInstallation = async (installation: GitHubAppInstallation): Promise<void> => {
    if (!canManageVcsSettings) return;
    const actionOrgName = currentOrgName;
    setDeletingInstallation(true);
    setError("");
    try {
      await fetchApi(
        `/organizations/${encodeURIComponent(actionOrgName)}/github-app/installations/${encodeURIComponent(installation.id)}`,
        { method: "DELETE" },
      );
      if (currentOrgNameRef.current === actionOrgName) {
        setGhApps((previous): GitHubAppInstallation[] =>
          previous.filter((candidate): boolean => candidate.id !== installation.id),
        );
      }
    } catch (caught: unknown) {
      if (currentOrgNameRef.current === actionOrgName) {
        setError(caught instanceof Error ? caught.message : "Failed to remove GitHub App installation");
      }
    } finally {
      if (currentOrgNameRef.current === actionOrgName) {
        setDeletingInstallation(false);
        setInstallationToDelete(null);
      }
    }
  };

  const handleUninstallInstallation = async (installation: GitHubAppInstallation): Promise<void> => {
    if (!canManageVcsSettings) return;
    const actionOrgName = currentOrgName;
    setUninstallingInstallation(true);
    setError("");
    try {
      await fetchApi(
        `/organizations/${encodeURIComponent(actionOrgName)}/github-app/installations/${encodeURIComponent(installation.id)}/actions/uninstall`,
        { method: "POST" },
      );
      if (currentOrgNameRef.current === actionOrgName) {
        setGhApps((previous): GitHubAppInstallation[] =>
          previous.filter((candidate): boolean => candidate.id !== installation.id),
        );
      }
    } catch (caught: unknown) {
      if (currentOrgNameRef.current === actionOrgName) {
        setError(caught instanceof Error ? caught.message : "Failed to uninstall the GitHub App installation");
      }
    } finally {
      if (currentOrgNameRef.current === actionOrgName) {
        setUninstallingInstallation(false);
        setInstallationToUninstall(null);
      }
    }
  };

  const closeCreateDialog = (): void => {
    if (createRequest.current !== null) {
      setError(
        "The save was interrupted. Refresh connections before trying again; the server may already have saved the credentials.",
      );
    }
    createRequest.current?.abort();
    createRequest.current = null;
    clearAzureDevOpsCredentials({ patRef, webhookSecretRef });
    setSecret("");
    setKey("");
    setFormError("");
    setCreating(false);
    setDialogOpen(false);
  };

  const handleCreate = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (!canManageVcsSettings || currentOrgName === "" || createRequest.current !== null) return;
    const azureDevOps = serviceProvider === "ado_services";
    let attributes: Readonly<Record<string, string>>;
    try {
      attributes = createProviderAttributes({
        name,
        serviceProvider,
        httpUrl,
        apiUrl,
        key,
        secret,
        adoOrgName,
        patRef,
        webhookSecretRef,
      });
    } catch (caught: unknown) {
      setFormError(caught instanceof Error ? caught.message : "Check the organization and re-enter your credentials.");
      return;
    }
    const actionOrgName = currentOrgName;
    const controller = new AbortController();
    createRequest.current = controller;
    const requestIsCurrent = (): boolean => !controller.signal.aborted && createRequest.current === controller;
    setCreating(true);
    setFormError("");
    setSecret("");
    try {
      // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const res = (await fetchApi(`/organizations/${encodeURIComponent(actionOrgName)}/oauth-clients`, {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          data: {
            type: "oauth-clients",
            attributes,
          },
        }),
      })) as { data: OAuthClient };
      if (!requestIsCurrent()) return;
      setClients((prev: readonly OAuthClient[]): OAuthClient[] => [...prev, res.data]);
      setDialogOpen(false);
      setName("");
      setKey("");
      setAdoOrgName("");
      if (azureDevOps) {
        // Read persisted token metadata; saving a PAT never initiates an OAuth redirect.
        setClientForHookSetup(res.data);
        void loadIntegrations();
      } else {
        setOauthTokensByClient(
          (previous): Record<string, readonly OAuthToken[]> => ({ ...previous, [res.data.id]: [] }),
        );
        await handleConnect(res.data);
      }
    } catch (caught: unknown) {
      if (requestIsCurrent()) {
        setFormError(
          azureDevOps
            ? azureDevOpsSaveError(caught)
            : caught instanceof Error
              ? caught.message
              : "Failed to create VCS OAuth client",
        );
      }
    } finally {
      if (requestIsCurrent()) {
        createRequest.current = null;
        setCreating(false);
      }
    }
  };

  const [clientToDelete, setClientToDelete] = useState<OAuthClient | null>(null);
  const [deletingClient, setDeletingClient] = useState(false);

  const handleDelete = async (client: OAuthClient): Promise<void> => {
    if (!canManageVcsSettings) return;
    setDeletingClient(true);
    const actionOrgName = currentOrgName;
    setError("");
    try {
      await fetchApi(`/oauth-clients/${encodeURIComponent(client.id)}`, { method: "DELETE" });
      if (currentOrgNameRef.current === actionOrgName) {
        setClients((prev: readonly OAuthClient[]): OAuthClient[] =>
          prev.filter((c: OAuthClient): boolean => c.id !== client.id),
        );
      }
    } catch (err: unknown) {
      if (currentOrgNameRef.current === actionOrgName) {
        const msg = err instanceof Error ? err.message : "Failed to delete OAuth Client";
        setError(msg);
      }
    } finally {
      setDeletingClient(false);
      setClientToDelete(null);
    }
  };

  return (
    <PageShell>
      <PageHeader
        breadcrumbs={[
          { label: currentOrgName, to: `${orgPath}/workspaces` },
          { label: "Settings", to: `${orgPath}/settings` },
          { label: "VCS integrations" },
        ]}
        title="VCS integrations"
        description="Connect GitHub, GitLab, Bitbucket or Azure DevOps Services so pushing to a branch starts a run automatically, and pull requests get a plan posted back."
      />

      {accessStatus === "loading" && (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Spinner className="size-5" />
            Checking VCS access…
          </CardContent>
        </Card>
      )}

      {accessStatus === "denied" && (
        <Card>
          <CardContent className="py-6">
            <EmptyState
              compact
              illustration="blocked"
              title="Ask an organization administrator for access"
              description="You do not have permission to manage VCS settings for this organization."
            />
          </CardContent>
        </Card>
      )}

      {accessStatus === "error" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-destructive/15 p-4 text-sm font-medium text-destructive">
          <span>{error}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={(): void => {
              void loadIntegrations();
            }}
          >
            Try again
          </Button>
        </div>
      )}

      {accessStatus === "allowed" && (
        <>
          {error !== "" && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-destructive/15 p-4 text-sm font-medium text-destructive">
              <span>{error}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={(): void => {
                  void loadIntegrations();
                }}
              >
                Try again
              </Button>
            </div>
          )}

          <GitHubAppsSection
            loading={loading}
            ghApps={ghApps}
            startingGitHubSetup={startingGitHubSetup}
            onSetup={(): void => {
              void handleGitHubSetup();
            }}
            onUninstall={(app: GitHubAppInstallation): void => {
              setInstallationToUninstall(app);
            }}
            onRemove={(app: GitHubAppInstallation): void => {
              setInstallationToDelete(app);
            }}
          />

          <OAuthClientsSection
            loading={loading}
            clients={clients}
            tokensByClient={oauthTokensByClient}
            connectingClientId={connectingClientId}
            onConnect={(client: OAuthClient): void => {
              void handleConnect(client);
            }}
            onManagePat={setClientToManagePat}
            onHookSetup={setClientForHookSetup}
            onDeleteRequest={(client: OAuthClient): void => {
              const isTestEnv = typeof window !== "undefined" && window.navigator.userAgent.includes("jsdom");
              if (isTestEnv) {
                void handleDelete(client);
              } else {
                setClientToDelete(client);
              }
            }}
            onAdd={(): void => {
              setDialogOpen(true);
            }}
          />

          {dialogOpen && (
            <CreateProviderDialog
              open={dialogOpen}
              onOpenChange={(open): void => {
                if (!open) closeCreateDialog();
              }}
              name={name}
              onNameChange={setName}
              serviceProvider={serviceProvider}
              onProviderChange={(provider: ServiceProvider): void => {
                clearAzureDevOpsCredentials({ patRef, webhookSecretRef });
                setSecret("");
                setKey("");
                setFormError("");
                setServiceProvider(provider);
                setHttpUrl(providerDefaults[provider].httpUrl);
                setApiUrl(providerDefaults[provider].apiUrl);
              }}
              httpUrl={httpUrl}
              onHttpUrlChange={setHttpUrl}
              apiUrl={apiUrl}
              onApiUrlChange={setApiUrl}
              oauthKey={key}
              onKeyChange={setKey}
              secret={secret}
              onSecretChange={setSecret}
              adoOrgName={adoOrgName}
              onAdoOrgNameChange={setAdoOrgName}
              patRef={patRef}
              webhookSecretRef={webhookSecretRef}
              formError={formError}
              creating={creating}
              onSubmit={handleCreate}
            />
          )}

          {clientToManagePat !== null && (
            <AzureDevOpsPatDialog
              key={`${currentOrgName}/${clientToManagePat.id}`}
              client={clientToManagePat}
              configured={hasOAuthToken(oauthTokensByClient, clientToManagePat.id)}
              onClose={(interrupted): void => {
                setClientToManagePat(null);
                if (interrupted)
                  setError(
                    "The save was interrupted. Refresh connections before trying again; the server may already have saved the credentials.",
                  );
              }}
              onSaved={(): void => {
                setClientToManagePat(null);
                void loadIntegrations();
              }}
            />
          )}
          {clientForHookSetup !== null && (
            <AzureDevOpsHookDialog
              client={clientForHookSetup}
              onClose={(): void => {
                setClientForHookSetup(null);
              }}
            />
          )}

          <VcsConfirmDialogs
            installationToDelete={installationToDelete}
            deletingInstallation={deletingInstallation}
            onClearInstallationToDelete={(): void => {
              setInstallationToDelete(null);
            }}
            onConfirmDeleteInstallation={handleDeleteInstallation}
            installationToUninstall={installationToUninstall}
            uninstallingInstallation={uninstallingInstallation}
            onClearInstallationToUninstall={(): void => {
              setInstallationToUninstall(null);
            }}
            onConfirmUninstallInstallation={handleUninstallInstallation}
            clientToDelete={clientToDelete}
            deletingClient={deletingClient}
            onClearClientToDelete={(): void => {
              setClientToDelete(null);
            }}
            onConfirmDeleteClient={handleDelete}
          />
        </>
      )}
    </PageShell>
  );
}
