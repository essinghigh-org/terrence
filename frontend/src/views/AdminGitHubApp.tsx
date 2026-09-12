import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import { ExternalLink, GitBranch, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import { fetchApi } from "../lib/api";
import { isNumber, isString } from "../lib/type-guards";
import { Button, buttonVariants } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Spinner } from "../components/ui/spinner";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { PageHeader, PageShell } from "../components/PageHeader";

type GitHubAppAttributes = Readonly<{
  configured?: boolean;
  status?: string;
  source?: string | null;
  "app-id"?: number | null;
  slug?: string | null;
  name?: string | null;
  owner?: string | null;
  "registration-url"?: string | null;
  "invalid-reason"?: string | null;
  "missing-owners"?: string[];
  "manifest-flow"?: string | null;
}>;

type GitHubAppDocument = Readonly<{ data?: { attributes?: GitHubAppAttributes } }>;

function RegistrationDetails({ attributes }: Readonly<{
  attributes: GitHubAppAttributes;
}>): React.JSX.Element {
  return (
    <dl className="grid gap-2 text-sm">
      <div className="flex justify-between gap-4"><dt className="text-muted-foreground">App ID</dt><dd>{isNumber(attributes["app-id"]) ? attributes["app-id"] : "—"}</dd></div>
      <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Slug</dt><dd>{attributes.slug ?? "—"}</dd></div>
      <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Owner</dt><dd>{attributes.owner ?? "—"}</dd></div>
    </dl>
  );
}

function RegistrationCard({
  loading,
  status,
  attributes,
  missingOwners,
  busy,
  onStartManifest,
  onValidate,
  onRegistrationDeleted,
}: Readonly<{
  loading: boolean;
  status: string;
  attributes: GitHubAppAttributes;
  missingOwners: string[];
  busy: string;
  onStartManifest: () => void;
  onValidate: () => void;
  onRegistrationDeleted: () => void;
}>): React.JSX.Element {
  const registrationUrl = attributes["registration-url"] ?? null;
  const source = attributes.source ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><GitBranch className="size-5" />Current registration</CardTitle>
        <CardDescription>The active App remains in place while a replacement is being installed and checked.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? <Spinner className="size-6 text-primary" /> : (
          <>
            <div className="flex items-center gap-2"><Badge variant={status === "active" ? "secondary" : "outline"}>{status}</Badge>{source !== null && <span className="text-sm text-muted-foreground">{source}</span>}</div>
            {status === "invalid" && attributes["invalid-reason"] !== null && attributes["invalid-reason"] !== undefined && <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{attributes["invalid-reason"]}</p>}
            <RegistrationDetails attributes={attributes} />
            {missingOwners.length > 0 && <p className="rounded-md bg-muted p-3 text-sm">Install the replacement App for: <strong>{missingOwners.join(", ")}</strong>.</p>}
            <div className="flex flex-wrap gap-2">
              <Button onClick={onStartManifest} disabled={busy !== ""}><ShieldCheck data-icon="inline-start" />{busy === "manifest" ? "Opening GitHub…" : "Create or replace with GitHub"}</Button>
              <Button variant="outline" onClick={onValidate} disabled={busy !== ""}>Validate credentials</Button>
              {registrationUrl !== null && <>
                <a className={buttonVariants({ variant: "outline" })} href={registrationUrl} target="_blank" rel="noreferrer"><ExternalLink data-icon="inline-start" />GitHub settings</a>
                <Button variant="outline" onClick={onRegistrationDeleted} disabled={busy !== ""}>I deleted it on GitHub</Button>
              </>}
            </div>
            {registrationUrl !== null && <p className="text-xs text-muted-foreground">Deleting the registration in GitHub uninstalls it everywhere. Terrence leaves that action to you; return here and validate the credentials afterward to confirm the connection state.</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function authorizationUrl(payload: unknown): string {
  const root = payload !== null && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const data = root["data"] !== null && typeof root["data"] === "object" ? root["data"] as Record<string, unknown> : {};
  const attributes = data["attributes"] !== null && typeof data["attributes"] === "object" ? data["attributes"] as Record<string, unknown> : {};
  const value = attributes["authorization-url"];
  if (!isString(value) || value === "") throw new Error("The server did not return a GitHub App setup URL.");
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") throw new Error("The server returned an unsafe GitHub App setup URL.");
  return url.toString();
}

export function AdminGitHubApp(): React.JSX.Element {
  const [attributes, setAttributes] = useState<GitHubAppAttributes>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [appId, setAppId] = useState("");
  const [slug, setSlug] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [httpUrl, setHttpUrl] = useState("");
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false);
  const [registrationDeletedDialogOpen, setRegistrationDeletedDialogOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      const response = await fetchApi("/admin/github-app") as GitHubAppDocument;
      setAttributes(response.data?.attributes ?? {});
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Failed to load GitHub App settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect((): void => { void load(); }, [load]);

  const startManifest = async (): Promise<void> => {
    setBusy("manifest");
    setError("");
    try {
      // The manifest setup endpoint negotiates its JSON body on either JSON
      // media type, but the JSON:API Accept gate requires vnd.api+json.
      const response = await fetchApi("/admin/github-app/manifest/setup", { headers: { Accept: "application/vnd.api+json" } });
      window.location.assign(authorizationUrl(response));
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Failed to start GitHub App setup.");
    } finally {
      setBusy("");
    }
  };

  const saveManual = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy("manual");
    setError("");
    setSaved(false);
    try {
      await fetchApi("/admin/github-app", {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "github-app",
            attributes: {
              "app-id": Number(appId),
              slug: slug.trim(),
              "private-key": privateKey,
              "webhook-secret": webhookSecret,
              ...(apiUrl.trim() === "" ? {} : { "api-url": apiUrl.trim() }),
              ...(httpUrl.trim() === "" ? {} : { "http-url": httpUrl.trim() }),
            },
          },
        }),
      });
      setPrivateKey("");
      setWebhookSecret("");
      setSaved(true);
      await load();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Failed to save the GitHub App.");
    } finally {
      setBusy("");
    }
  };

  const action = async (name: "disconnect" | "import-environment" | "validate"): Promise<void> => {
    setBusy(name);
    setError("");
    setSaved(false);
    try {
      await fetchApi(`/admin/github-app/actions/${name}`, { method: "POST" });
      setSaved(name === "validate" ? true : false);
      await load();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : `GitHub App ${name} failed.`);
    } finally {
      setBusy("");
    }
  };

  const status = attributes.status ?? "unconfigured";
  const missingOwners = attributes["missing-owners"] ?? [];

  return (
    <PageShell>
      <PageHeader
        eyebrow="Site administration"
        title="GitHub App"
        description="Provision and manage the site-wide GitHub App without exposing private credentials to the browser."
        action={<Button variant="outline" size="sm" onClick={(): void => { void load(); }} disabled={loading}><RefreshCw data-icon="inline-start" />Refresh</Button>}
      />

      {error !== "" && <div className="mb-4 rounded-md bg-destructive/15 p-4 text-sm font-medium text-destructive">{error}</div>}
      {saved && <div className="mb-4 rounded-md bg-primary/10 p-4 text-sm font-medium text-primary">GitHub App settings updated.</div>}

      <div className="grid gap-6 xl:grid-cols-2">
        <RegistrationCard
          loading={loading}
          status={status}
          attributes={attributes}
          missingOwners={missingOwners}
          busy={busy}
          onStartManifest={(): void => { void startManifest(); }}
          onValidate={(): void => { void action("validate"); }}
          onRegistrationDeleted={(): void => { setRegistrationDeletedDialogOpen(true); }}
        />

        <Card>
          <CardHeader>
            <CardTitle>Environment recovery</CardTitle>
            <CardDescription>Use the legacy environment values only when an operator explicitly requests a retry.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">Disconnect removes stored credentials and keeps workspace configuration. It does not call GitHub or uninstall anything.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={(): void => { void action("import-environment"); }} disabled={busy !== ""}>Import environment</Button>
              <Button variant="destructive" onClick={(): void => { setDisconnectDialogOpen(true); }} disabled={busy !== ""}><Unplug data-icon="inline-start" />Disconnect from Terrence</Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>Use an existing GitHub App</CardTitle><CardDescription>Terrence validates the App ID and key with GitHub before storing encrypted credentials.</CardDescription></CardHeader>
        <CardContent>
          <form className="grid gap-4 md:grid-cols-2" onSubmit={(event): void => { void saveManual(event); }}>
            <Input aria-label="GitHub App ID" value={appId} onChange={(event): void => { setAppId(event.target.value); }} placeholder="App ID" inputMode="numeric" required />
            <Input aria-label="GitHub App slug" value={slug} onChange={(event): void => { setSlug(event.target.value); }} placeholder="App slug" required />
            <Input className="md:col-span-2" aria-label="GitHub App private key" value={privateKey} onChange={(event): void => { setPrivateKey(event.target.value); }} placeholder="Private key (PEM)" type="password" autoComplete="new-password" required />
            <Input aria-label="GitHub webhook secret" value={webhookSecret} onChange={(event): void => { setWebhookSecret(event.target.value); }} placeholder="Webhook secret" type="password" autoComplete="new-password" required />
            <Input aria-label="GitHub API URL" value={apiUrl} onChange={(event): void => { setApiUrl(event.target.value); }} placeholder="API URL (optional)" />
            <Input aria-label="GitHub HTTP URL" value={httpUrl} onChange={(event): void => { setHttpUrl(event.target.value); }} placeholder="HTTP URL (optional)" />
            <div className="md:col-span-2"><Button type="submit" disabled={busy !== ""}>{busy === "manual" ? "Validating…" : "Save existing App"}</Button></div>
          </form>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={disconnectDialogOpen}
        onOpenChange={(open): void => { if (busy !== "disconnect") setDisconnectDialogOpen(open); }}
        title="Disconnect GitHub App from Terrence"
        description="This destroys Terrence's stored private key and webhook secret, keeps workspace and repository configuration, and does not contact GitHub. Reconnect or explicitly import the environment configuration later if needed."
        confirmText="Disconnect from Terrence"
        confirmVariant="destructive"
        requireCheckbox="I understand that Terrence will stop minting GitHub installation tokens until an App is connected again."
        loading={busy === "disconnect"}
        onConfirm={async (): Promise<void> => {
          await action("disconnect");
          setDisconnectDialogOpen(false);
        }}
      />

      <ConfirmDialog
        open={registrationDeletedDialogOpen}
        onOpenChange={(open): void => { if (busy !== "validate") setRegistrationDeletedDialogOpen(open); }}
        title="Confirm GitHub registration deletion"
        description="Confirm that you deleted this App registration in GitHub. Terrence will validate the stored credentials and show the connection as invalid if GitHub no longer accepts them. This confirmation does not delete anything on GitHub."
        confirmText="Validate deleted registration"
        requireCheckbox="I confirm that I deleted the GitHub App registration in GitHub."
        loading={busy === "validate"}
        onConfirm={async (): Promise<void> => {
          await action("validate");
          setRegistrationDeletedDialogOpen(false);
        }}
      />
    </PageShell>
  );
}
