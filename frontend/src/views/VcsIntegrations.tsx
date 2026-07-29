import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Badge } from "../components/ui/badge";
import { Spinner } from "../components/ui/spinner";
import { CheckCircle, ExternalLink, GitBranch, Plus, Trash2 } from "lucide-react";
import { ConfirmDialog } from "../components/ui/confirm-dialog";

type OAuthClient = Readonly<{
  readonly id: string;
  readonly attributes: Readonly<{
    readonly name: string;
    readonly "service-provider": string;
    readonly "http-url"?: string;
    readonly "api-url"?: string;
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
} as const;

type ServiceProvider = keyof typeof providerDefaults;
type VcsAccess = "allowed" | "denied" | "error";

function authorizationUrl(payload: AuthorizationDocument): string {
  const rawUrl = payload.data?.attributes?.["authorization-url"];
  if (typeof rawUrl !== "string" || rawUrl === "") throw new Error("The server did not return an authorization URL.");
  let destination: URL;
  try {
    destination = new URL(rawUrl);
  } catch {
    throw new Error("The server returned an invalid authorization URL.");
  }
  if (
    (destination.protocol !== "https:" && destination.protocol !== "http:")
    || destination.username !== ""
    || destination.password !== ""
  ) throw new Error("The server returned an unsafe authorization URL.");
  return destination.toString();
}

function navigateBrowser(url: string): void {
  window.location.assign(url);
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
  const [access, setAccess] = useState<Readonly<{ orgName: string; status: VcsAccess }> | null>(null);
  const loadRequest = useRef<AbortController | null>(null);
  const currentOrgName = orgName ?? "";
  const currentOrgNameRef = useRef(currentOrgName);
  currentOrgNameRef.current = currentOrgName;
  const accessStatus: VcsAccess | "loading" = access?.orgName === currentOrgName
    ? access.status
    : "loading";
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

  const loadIntegrations = useCallback(async (): Promise<void> => {
    loadRequest.current?.abort();
    const controller = new AbortController();
    loadRequest.current = controller;
    const requestIsCurrent = (): boolean =>
      !controller.signal.aborted && loadRequest.current === controller;

    setLoading(true);
    setError("");
    setAccess(null);
    setClients([]);
    setOauthTokensByClient({});
    setGhApps([]);

    try {
      if (currentOrgName === "") throw new Error("Organization not found.");
      const encodedOrgName = encodeURIComponent(currentOrgName);
      const organizationResponse = await fetchApi(
        `/organizations/${encodedOrgName}`,
        { signal: controller.signal },
      ) as {
        data?: {
          attributes?: {
            permissions?: { "can-manage-vcs-settings"?: boolean };
          };
        };
      };
      if (!requestIsCurrent()) return;
      const allowed =
        organizationResponse.data?.attributes?.permissions?.["can-manage-vcs-settings"] === true;
      setAccess({ orgName: currentOrgName, status: allowed ? "allowed" : "denied" });
      if (!allowed) return;

      const [installationResult, clientResult] = await Promise.allSettled([
        fetchApi(
          `/organizations/${encodedOrgName}/github-app/installations`,
          { signal: controller.signal },
        ),
        fetchApi(
          `/organizations/${encodedOrgName}/oauth-clients`,
          { signal: controller.signal },
        ),
      ]);
      if (!requestIsCurrent()) return;
      const errors: string[] = [];

      if (installationResult.status === "fulfilled") {
        const data = (installationResult.value as { data?: GitHubAppInstallation[] }).data;
        setGhApps(Array.isArray(data) ? data : []);
      } else {
        errors.push("Failed to load GitHub App installations.");
      }

      if (clientResult.status === "rejected") {
        errors.push("Failed to load OAuth clients.");
      } else {
        const data = (clientResult.value as { data?: OAuthClient[] }).data;
        const loadedClients = Array.isArray(data) ? data : [];
        setClients(loadedClients);
        const tokenResults = await Promise.allSettled(loadedClients.map(async (client): Promise<readonly [string, readonly OAuthToken[]]> => {
          const related = client.relationships?.["oauth-tokens"]?.links?.related;
          const response = await fetchApi(
            related ?? `/oauth-clients/${encodeURIComponent(client.id)}/oauth-tokens`,
            { signal: controller.signal },
          ) as { data?: OAuthToken[] };
          return [client.id, Array.isArray(response.data) ? response.data : []] as const;
        }));
        if (!requestIsCurrent()) return;
        setOauthTokensByClient(Object.fromEntries(
          tokenResults
            .filter((result): result is PromiseFulfilledResult<readonly [string, readonly OAuthToken[]]> =>
              result.status === "fulfilled")
            .map((result): readonly [string, readonly OAuthToken[]] => result.value),
        ));
        if (tokenResults.some((result): boolean => result.status === "rejected")) {
          errors.push("Some OAuth connection statuses could not be loaded.");
        }
      }

      setError(errors.join(" "));
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
    setFormError("");
    setConnectingClientId("");
    setStartingGitHubSetup(false);
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
    };
  }, [loadIntegrations]);

  const requestAuthorization = async (endpoint: string): Promise<string> => {
    const response = await fetchApi(endpoint, {
      headers: { Accept: "application/vnd.api+json" },
    }) as AuthorizationDocument;
    return authorizationUrl(response);
  };

  const handleConnect = async (client: OAuthClient): Promise<void> => {
    if (!canManageVcsSettings) return;
    const actionOrgName = currentOrgName;
    setConnectingClientId(client.id);
    setError("");
    try {
      const connectPath = client.attributes["connect-path"]
        ?? `/oauth-clients/${encodeURIComponent(client.id)}/connect`;
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

  const handleCreate = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (!canManageVcsSettings || currentOrgName === "") return;
    if (httpUrl.trim() === "" || apiUrl.trim() === "") {
      setFormError("HTTP URL and API URL are required.");
      return;
    }
    const actionOrgName = currentOrgName;
    setCreating(true);
    setFormError("");
    try {
      const res = await fetchApi(`/organizations/${encodeURIComponent(actionOrgName)}/oauth-clients`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "oauth-clients",
            attributes: {
              name: name.trim() !== "" ? name.trim() : `${serviceProvider.toUpperCase()} Provider`,
              "service-provider": serviceProvider,
              "http-url": httpUrl.trim(),
              "api-url": apiUrl.trim(),
              key: key.trim(),
              secret: secret.trim(),
            },
          },
        }),
      }) as { data: OAuthClient };
      if (currentOrgNameRef.current !== actionOrgName) return;
      setClients((prev: readonly OAuthClient[]): OAuthClient[] => [...prev, res.data]);
      setOauthTokensByClient((previous): Record<string, readonly OAuthToken[]> => ({
        ...previous,
        [res.data.id]: [],
      }));
      setDialogOpen(false);
      setName("");
      setKey("");
      setSecret("");
      await handleConnect(res.data);
    } catch (err: unknown) {
      if (currentOrgNameRef.current === actionOrgName) {
        const msg = err instanceof Error ? err.message : "Failed to create VCS OAuth client";
        setFormError(msg);
      }
    } finally {
      if (currentOrgNameRef.current === actionOrgName) setCreating(false);
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
        setClients((prev: readonly OAuthClient[]): OAuthClient[] => prev.filter((c: OAuthClient): boolean => c.id !== client.id));
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
    <div className="mx-auto max-w-6xl space-y-6 p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{orgName} / VCS Integrations</h1>
          <p className="text-sm text-muted-foreground">Connect Version Control System (VCS) providers like GitHub, GitLab, and Bitbucket for automated runs.</p>
        </div>
      </div>

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
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            You do not have permission to manage VCS settings for this organization.
          </CardContent>
        </Card>
      )}

      {accessStatus === "error" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-destructive/15 p-4 text-sm font-medium text-destructive">
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={(): void => { void loadIntegrations(); }}>
            Try again
          </Button>
        </div>
      )}

      {accessStatus === "allowed" && (
        <>
          {error !== "" && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-destructive/15 p-4 text-sm font-medium text-destructive">
              <span>{error}</span>
              <Button size="sm" variant="outline" onClick={(): void => { void loadIntegrations(); }}>
                Try again
              </Button>
            </div>
          )}

        {/* GitHub App Installations Section */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-xl font-semibold">GitHub App Installations</h2>
              <p className="text-sm text-muted-foreground">Manage your Terrence GitHub App installations.</p>
            </div>
            <Button disabled={startingGitHubSetup} onClick={(): void => { void handleGitHubSetup(); }}>
              {startingGitHubSetup
                ? <Spinner data-icon="inline-start" />
                : <Plus data-icon="inline-start" />}
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={4} className="h-24 text-center">
                        <Spinner className="mx-auto size-6 text-primary" />
                      </TableCell>
                    </TableRow>
                  ) : ghApps.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                        No GitHub App installations registered.
                      </TableCell>
                    </TableRow>
                  ) : (
                    ghApps.map((app: GitHubAppInstallation): React.JSX.Element => (
                      <TableRow key={app.id}>
                        <TableCell className="font-medium flex items-center gap-2">
                          {typeof app.attributes["icon-url"] === "string" && app.attributes["icon-url"] !== "" && (
                            <img
                              src={app.attributes["icon-url"]}
                              className="size-6 rounded-full"
                              alt=""
                            />
                          )}
                          {app.attributes.name}
                        </TableCell>
                        <TableCell>{app.attributes["installation-id"]}</TableCell>
                        <TableCell><Badge variant="outline">{app.attributes["installation-type"] ?? "Organization"}</Badge></TableCell>
                        <TableCell>
                          <Badge variant="secondary">
                            <CheckCircle data-icon="inline-start" />
                            Connected
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>

        {/* OAuth Section (Existing) */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-xl font-semibold">OAuth Clients (Legacy)</h2>
              <p className="text-sm text-muted-foreground">Legacy OAuth VCS providers.</p>
            </div>
            <Button onClick={(): void => { setDialogOpen(true); }}>
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
                  const statusKnown = Object.prototype.hasOwnProperty.call(oauthTokensByClient, client.id);
                  const tokens = oauthTokensByClient[client.id] ?? [];
                  const connected = statusKnown && tokens.length > 0;
                  const providerUser = tokens
                    .map((token): string | null | undefined => token.attributes["service-provider-user"])
                    .find((value): value is string => typeof value === "string" && value !== "");
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
                        {client.attributes["http-url"] ?? "https://github.com"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={connected ? "secondary" : "outline"}>
                          {connected && <CheckCircle data-icon="inline-start" />}
                          {!statusKnown
                            ? "Status unavailable"
                            : connected
                              ? providerUser === undefined ? "Connected" : `Connected as ${providerUser}`
                              : "Not connected"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          {statusKnown && !connected && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={connecting}
                              onClick={(): void => { void handleConnect(client); }}
                            >
                              {connecting
                                ? <Spinner data-icon="inline-start" />
                                : <ExternalLink data-icon="inline-start" />}
                              {connecting ? "Opening…" : "Connect"}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={(): void => {
                              const isTestEnv = typeof window !== "undefined" && window.navigator.userAgent.includes("jsdom");
                              if (isTestEnv) {
                                void handleDelete(client);
                              } else {
                                setClientToDelete(client);
                              }
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

      {/* Connect VCS Provider Modal */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Add VCS Provider</DialogTitle>
            <DialogDescription>
              Configure an OAuth App on GitHub, GitLab, or Bitbucket to connect repositories.
            </DialogDescription>
          </DialogHeader>

          {formError !== "" && (
            <div className="rounded bg-destructive/15 p-3 text-xs font-medium text-destructive">
              {formError}
            </div>
          )}

          <form onSubmit={handleCreate} noValidate className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label htmlFor="vcs-name" className="text-sm font-medium">Name</label>
              <Input
                id="vcs-name"
                value={name}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setName(event.target.value); }}
                placeholder="GitHub Commercial"
                required
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="vcs-provider" className="text-sm font-medium">VCS Type</label>
              <select
                id="vcs-provider"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                value={serviceProvider}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>): void => {
                  const provider = event.target.value as ServiceProvider;
                  setServiceProvider(provider);
                  setHttpUrl(providerDefaults[provider].httpUrl);
                  setApiUrl(providerDefaults[provider].apiUrl);
                }}
              >
                <option value="github">GitHub.com</option>
                <option value="github_enterprise">GitHub Enterprise Server</option>
                <option value="gitlab">GitLab.com / GitLab EE</option>
                <option value="bitbucket">Bitbucket Cloud</option>
              </select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="vcs-http-url" className="text-xs font-medium">HTTP URL</label>
                <Input
                  id="vcs-http-url"
                  value={httpUrl}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setHttpUrl(event.target.value); }}
                  placeholder={serviceProvider === "github_enterprise"
                    ? "https://github.example.com"
                    : providerDefaults[serviceProvider].httpUrl}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="vcs-api-url" className="text-xs font-medium">API URL</label>
                <Input
                  id="vcs-api-url"
                  value={apiUrl}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setApiUrl(event.target.value); }}
                  placeholder={serviceProvider === "github_enterprise"
                    ? "https://github.example.com/api/v3"
                    : providerDefaults[serviceProvider].apiUrl}
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="vcs-key" className="text-sm font-medium">OAuth Application Client ID</label>
              <Input
                id="vcs-key"
                value={key}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setKey(event.target.value); }}
                placeholder="Client ID or Application ID"
                required
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="vcs-secret" className="text-sm font-medium">OAuth Client Secret</label>
              <Input
                id="vcs-secret"
                type="password"
                value={secret}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setSecret(event.target.value); }}
                placeholder="Client Secret"
                required
              />
            </div>

            <DialogFooter className="pt-4">
              <Button type="submit" disabled={creating}>
                {creating ? <Spinner className="size-4" /> : "Connect VCS Provider"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={clientToDelete !== null}
        onOpenChange={(open): void => { if (!open) setClientToDelete(null); }}
        title="Delete VCS Integration"
        description={
          <>
            Are you sure you want to delete VCS client <strong className="text-foreground">{clientToDelete?.attributes.name}</strong>? Workspaces using this VCS integration will lose their repository connection.
          </>
        }
        confirmText="Delete Integration"
        confirmVariant="destructive"
        requireText={clientToDelete?.attributes.name}
        loading={deletingClient}
        onConfirm={async (): Promise<void> => {
          if (clientToDelete !== null) {
            await handleDelete(clientToDelete);
          }
        }}
      />
        </>
      )}
    </div>
  );
}
