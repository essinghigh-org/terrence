import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Badge } from "../components/ui/badge";
import { Spinner } from "../components/ui/spinner";
import { GitBranch, Plus, Trash2, CheckCircle } from "lucide-react";

type OAuthClient = {
  id: string;
  attributes: {
    name: string;
    "service-provider": string;
    "http-url"?: string;
    "api-url"?: string;
    "oauth-token-ids"?: string[];
  };
}

export function VcsIntegrations(): React.JSX.Element {
  const { orgName } = useParams<{ orgName: string }>();
  const [clients, setClients] = useState<OAuthClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Create Modal
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [serviceProvider, setServiceProvider] = useState("github");
  const [httpUrl, setHttpUrl] = useState("https://github.com");
  const [apiUrl, setApiUrl] = useState("https://api.github.com");
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");

  useEffect((): void => {
    if (orgName != null) void loadOAuthClients();
  }, [orgName]);

  const loadOAuthClients = async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      const res = await fetchApi(`/organizations/${orgName ?? ""}/oauth-clients`) as { data: OAuthClient[] };
      setClients(res.data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load VCS OAuth Clients";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (orgName == null) return;
    setCreating(true);
    setFormError("");
    try {
      const res = await fetchApi(`/organizations/${orgName}/oauth-clients`, {
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
      setClients((prev: OAuthClient[]): OAuthClient[] => [...prev, res.data]);
      setDialogOpen(false);
      setName("");
      setKey("");
      setSecret("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create VCS OAuth client";
      setFormError(msg);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (client: OAuthClient): Promise<void> => {
    if (!window.confirm(`Delete VCS OAuth client "${client.attributes.name}"?`)) return;
    setError("");
    try {
      await fetchApi(`/oauth-clients/${client.id}`, { method: "DELETE" });
      setClients((prev: OAuthClient[]): OAuthClient[] => prev.filter((c: OAuthClient): boolean => c.id !== client.id));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete OAuth Client";
      setError(msg);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{orgName} / VCS Integrations</h1>
          <p className="text-sm text-muted-foreground">Connect Version Control System (VCS) providers like GitHub, GitLab, and Bitbucket for automated runs.</p>
        </div>
        <Button onClick={(): void => { setDialogOpen(true); }}>
          <Plus className="mr-1.5 size-4" /> Add VCS Provider
        </Button>
      </div>

      {error !== "" && (
        <div className="rounded-md bg-destructive/15 p-4 text-sm font-medium text-destructive">
          {error}
        </div>
      )}

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
                clients.map((client: OAuthClient): React.JSX.Element => (
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
                      <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                        <CheckCircle className="size-3.5" /> Connected
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="destructive" onClick={(): void => { void handleDelete(client); }}>
                        <Trash2 className="size-3.5 mr-1" /> Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

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
                  setServiceProvider(event.target.value);
                  if (event.target.value === "gitlab") {
                    setHttpUrl("https://gitlab.com");
                    setApiUrl("https://gitlab.com/api/v4");
                  } else {
                    setHttpUrl("https://github.com");
                    setApiUrl("https://api.github.com");
                  }
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
                  placeholder="https://github.com"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="vcs-api-url" className="text-xs font-medium">API URL</label>
                <Input
                  id="vcs-api-url"
                  value={apiUrl}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setApiUrl(event.target.value); }}
                  placeholder="https://api.github.com"
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
    </div>
  );
}
