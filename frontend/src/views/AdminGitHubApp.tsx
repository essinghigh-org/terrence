import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import { ExternalLink, GitBranch, ShieldCheck, Unplug } from "lucide-react";
import { fetchApi } from "../lib/api";
import { githubAppAuthorizationUrl, githubAppSourceLabel, githubAppStorageNotice, type GitHubAppAttributes } from "../lib/github-app-admin";
import { Button, buttonVariants } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Spinner } from "../components/ui/spinner";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { PageHeader, PageShell } from "../components/PageHeader";

type GitHubAppDocument = Readonly<{ data?: { attributes?: GitHubAppAttributes } }>;
type AppAction = "disconnect" | "import-environment" | "validate";

function CredentialStorage({ attributes }: Readonly<{ attributes: GitHubAppAttributes }>): React.JSX.Element {
  const notice = githubAppStorageNotice(attributes);
  return (
    <div className="rounded-md border bg-muted/30 p-4 text-sm">
      <p className="font-medium">{notice.title}</p>
      <p className="mt-1 text-muted-foreground">{notice.description}</p>
      {notice.canRemoveEnvironment && <>
        <p className="mt-3">You may remove <code>GITHUB_APP_ID</code>, <code>GITHUB_APP_SLUG</code>, <code>GITHUB_APP_PRIVATE_KEY</code>, and <code>GITHUB_WEBHOOK_SECRET</code> from the deployment.</p>
        <p className="mt-2 text-muted-foreground">Keep the database and <code>STORAGE_DIR</code> persistent, and retain <code>ENCRYPTION_PASSWORD</code> if configured. Keep custom GitHub API/HTTP URLs for future setup. Removing deployment variables does not revoke the GitHub key.</p>
      </>}
    </div>
  );
}

function CreateAppForm({ busy, replacing, onCreate }: Readonly<{
  busy: boolean;
  replacing: boolean;
  onCreate: (organization: string, publicApp: boolean) => Promise<void>;
}>): React.JSX.Element {
  const [organization, setOrganization] = useState("");
  const [publicApp, setPublicApp] = useState(false);
  return (
    <form className="space-y-4" onSubmit={(event): void => { event.preventDefault(); void onCreate(organization, publicApp); }}>
      <p className="text-sm text-muted-foreground">{replacing
        ? "Your current app stays active until the replacement is installed and verified for every required account. Do not delete the old app first."
        : "Terrence fills in the URLs, events, and permissions. Review the app name on GitHub, create it, then grant repository access."}</p>
      <label className="block space-y-2 text-sm font-medium">
        <span>GitHub organization (optional)</span>
        <Input value={organization} onChange={(event): void => { setOrganization(event.target.value); }} placeholder="e.g. essinghigh-org" autoComplete="off" disabled={busy} />
        <span className="block font-normal text-muted-foreground">Use the organization login to register the app there. Leave blank to register under your personal GitHub account.</span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={publicApp} onChange={(event): void => { setPublicApp(event.target.checked); }} disabled={busy} className="mt-1" />
        <span>Allow other GitHub accounts to install this app.<span className="block text-muted-foreground">Leave unchecked for an app restricted to its owning account. Enable this when replacing an app installed across multiple owners.</span></span>
      </label>
      <Button type="submit" disabled={busy}><ShieldCheck data-icon="inline-start" />{busy ? "Please wait…" : replacing ? "Create replacement on GitHub" : "Create GitHub App"}</Button>
    </form>
  );
}

function ExistingAppForm({ busy, onSave }: Readonly<{
  busy: boolean;
  onSave: (attributes: Readonly<Record<string, unknown>>) => Promise<boolean>;
}>): React.JSX.Element {
  const [appId, setAppId] = useState("");
  const [slug, setSlug] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [httpUrl, setHttpUrl] = useState("");
  const save = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const saved = await onSave({
      "app-id": Number(appId), slug: slug.trim(), "private-key": privateKey, "webhook-secret": webhookSecret,
      ...(apiUrl.trim() === "" ? {} : { "api-url": apiUrl.trim() }),
      ...(httpUrl.trim() === "" ? {} : { "http-url": httpUrl.trim() }),
    });
    if (saved) { setPrivateKey(""); setWebhookSecret(""); }
  };
  return (
    <form className="grid gap-4 pt-4 md:grid-cols-2" onSubmit={(event): void => { void save(event); }}>
      <p className="text-sm text-muted-foreground md:col-span-2">Use the credentials for an existing app. Terrence validates its identity before storing encrypted credentials. This replaces the stored credentials immediately; use automatic replacement above to migrate installations to a new app.</p>
      <label className="space-y-2 text-sm"><span>App ID</span><Input value={appId} onChange={(event): void => { setAppId(event.target.value); }} inputMode="numeric" pattern="[1-9][0-9]*" required disabled={busy} /></label>
      <label className="space-y-2 text-sm"><span>App slug</span><Input value={slug} onChange={(event): void => { setSlug(event.target.value); }} required disabled={busy} /></label>
      <label className="space-y-2 text-sm md:col-span-2"><span>Private key (PEM)</span><textarea className="min-h-28 w-full rounded-md border bg-background p-3 font-mono text-sm" value={privateKey} onChange={(event): void => { setPrivateKey(event.target.value); }} autoComplete="off" spellCheck={false} required disabled={busy} /></label>
      <label className="space-y-2 text-sm md:col-span-2"><span>Webhook secret</span><Input value={webhookSecret} onChange={(event): void => { setWebhookSecret(event.target.value); }} type="password" autoComplete="new-password" required disabled={busy} /></label>
      <label className="space-y-2 text-sm"><span>GitHub API URL (optional)</span><Input value={apiUrl} onChange={(event): void => { setApiUrl(event.target.value); }} type="url" disabled={busy} /></label>
      <label className="space-y-2 text-sm"><span>GitHub HTTP URL (optional)</span><Input value={httpUrl} onChange={(event): void => { setHttpUrl(event.target.value); }} type="url" disabled={busy} /></label>
      <div className="md:col-span-2"><Button type="submit" variant="outline" disabled={busy}>Validate and save existing app</Button></div>
    </form>
  );
}

function ConnectionCard({ attributes, busy, onValidate }: Readonly<{
  attributes: GitHubAppAttributes;
  busy: boolean;
  onValidate: () => void;
}>): React.JSX.Element {
  const status = attributes.status ?? "unconfigured";
  const label = status === "active" ? attributes["connection-verified"] === true ? "Connected" : "Configured" : status === "invalid" ? "Needs attention" : status === "disconnected" ? "Disconnected" : "Not connected";
  const registrationUrl = attributes["registration-url"];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><GitBranch className="size-5" />{attributes.name ?? attributes.slug ?? "GitHub connection"}</CardTitle>
        <CardDescription>The site-wide app used by Terrence organizations and their repositories.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2"><Badge variant={status === "active" ? "secondary" : "outline"}>{label}</Badge>{attributes.configured === true && <span className="text-sm text-muted-foreground">{githubAppSourceLabel(attributes.source)}</span>}</div>
        {attributes["invalid-reason"] && <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{attributes["invalid-reason"]}</p>}
        {attributes.configured === true && <>
          <dl className="grid gap-2 text-sm sm:grid-cols-3">
            <div><dt className="text-muted-foreground">Owner</dt><dd>{attributes.owner ?? "Unknown"}</dd></div>
            <div><dt className="text-muted-foreground">App slug</dt><dd className="break-all">{attributes.slug ?? "—"}</dd></div>
            <div><dt className="text-muted-foreground">App ID</dt><dd>{attributes["app-id"] ?? "—"}</dd></div>
          </dl>
          <div className="flex flex-wrap gap-2">
            {status === "active" && <Button variant="outline" onClick={onValidate} disabled={busy}>Check connection</Button>}
            {registrationUrl && <a className={buttonVariants({ variant: "outline" })} href={registrationUrl} target="_blank" rel="noreferrer"><ExternalLink data-icon="inline-start" />Open on GitHub</a>}
          </div>
        </>}
        {status === "invalid" && <p className="text-sm text-muted-foreground">Reconnect with corrected credentials or create a replacement under Advanced below.</p>}
        <CredentialStorage attributes={attributes} />
      </CardContent>
    </Card>
  );
}

export function AdminGitHubApp(): React.JSX.Element {
  const [attributes, setAttributes] = useState<GitHubAppAttributes | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await fetchApi("/admin/github-app") as GitHubAppDocument;
      if (response.data?.attributes === undefined) throw new Error("The server did not return GitHub App settings.");
      setAttributes(response.data.attributes);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect((): void => {
    void load().catch((caught: unknown): void => { setError(caught instanceof Error ? caught.message : "Failed to load GitHub App settings."); });
  }, [load]);

  const startFlow = async (flow: "manifest" | "installation", organization = "", publicApp = false): Promise<void> => {
    setBusy(flow);
    setError("");
    setNotice("");
    try {
      const query = new URLSearchParams({ organization: organization.trim(), public: String(publicApp) });
      const path = flow === "manifest" ? `/admin/github-app/manifest/setup?${query}` : "/admin/github-app/manifest/resume";
      const response = await fetchApi(path, { headers: { Accept: "application/vnd.api+json" } });
      window.location.assign(githubAppAuthorizationUrl(response, window.location.origin, flow));
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Failed to start GitHub App setup.");
    } finally { setBusy(""); }
  };

  const action = async (name: AppAction): Promise<boolean> => {
    setBusy(name); setError(""); setNotice("");
    try {
      await fetchApi(`/admin/github-app/actions/${name}`, { method: "POST" });
      await load();
      setNotice(name === "validate" ? "GitHub accepted the app credentials." : name === "import-environment" ? "Environment credentials imported and encrypted in the database." : "Disconnected from Terrence. The GitHub registration and workspace configuration have not been deleted.");
      return true;
    } catch (caught: unknown) {
      // A failed validation may have marked the record invalid. Refresh before
      // displaying the error so a stale Connected badge cannot mask that state.
      await load().catch((): void => { setAttributes(null); });
      setError(caught instanceof Error ? caught.message : `GitHub App ${name} failed.`);
      return false;
    } finally { setBusy(""); }
  };

  const saveManual = async (values: Readonly<Record<string, unknown>>): Promise<boolean> => {
    setBusy("manual"); setError(""); setNotice("");
    try {
      await fetchApi("/admin/github-app", { method: "POST", body: JSON.stringify({ data: { type: "github-app", attributes: values } }) });
      await load();
      setNotice("GitHub App credentials validated and saved in encrypted database storage.");
      return true;
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Failed to save the GitHub App.");
      return false;
    } finally { setBusy(""); }
  };

  const disabled = busy !== "" || loading;
  const hasApp = attributes?.configured === true;
  const pending = attributes?.["pending-replacement"] === true;

  return (
    <PageShell>
      <PageHeader eyebrow="Site administration" title="GitHub App" description="Connect GitHub, manage the app, and check where its credentials are stored." />
      {error !== "" && <div role="alert" className="mb-4 rounded-md bg-destructive/15 p-4 text-sm text-destructive">{error}</div>}
      {notice !== "" && <div role="status" className="mb-4 rounded-md bg-primary/10 p-4 text-sm text-primary">{notice}</div>}
      {loading && attributes === null && <Spinner className="size-6 text-primary" />}
      {!loading && attributes === null && <Button variant="outline" onClick={(): void => { setError(""); void load().catch((caught: unknown): void => { setError(caught instanceof Error ? caught.message : "Failed to load settings."); }); }}>Retry loading settings</Button>}
      {attributes !== null && <div className="space-y-6">
        <ConnectionCard attributes={attributes} busy={disabled} onValidate={(): void => { void action("validate"); }} />
        {pending && <Card>
          <CardHeader><CardTitle>Finish {hasApp ? "the replacement" : "connecting the app"}</CardTitle><CardDescription>{hasApp ? "Your current app is still in use. The new app has been created but setup is not complete." : "The app has been created. Grant repository access on GitHub to finish connecting it."}</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            {(attributes["missing-owners"] ?? []).length > 0 && <p className="text-sm">Still needs installation for: <strong>{attributes["missing-owners"]?.join(", ")}</strong>.</p>}
            <Button onClick={(): void => { void startFlow("installation"); }} disabled={disabled}>Continue installation on GitHub</Button>
          </CardContent>
        </Card>}
        {!hasApp && !pending && <Card>
          <CardHeader><CardTitle>Connect GitHub</CardTitle><CardDescription>Create a preconfigured app without copying private keys.</CardDescription></CardHeader>
          <CardContent><CreateAppForm busy={disabled} replacing={false} onCreate={async (organization, publicApp): Promise<void> => { await startFlow("manifest", organization, publicApp); }} /></CardContent>
        </Card>}
        <details className="rounded-xl border p-5">
          <summary className="cursor-pointer font-medium">Advanced: replacement, manual setup, and recovery</summary>
          <div className="mt-5 space-y-6">
            {(hasApp || pending) && <section className="space-y-3">
              <h2 className="text-sm font-semibold">{pending ? "Start a different registration" : "Replace the app"}</h2>
              {pending && <p className="text-sm text-muted-foreground">Creating another app supersedes the unfinished setup. It does not delete that registration on GitHub.</p>}
              <CreateAppForm busy={disabled} replacing={hasApp} onCreate={async (organization, publicApp): Promise<void> => { await startFlow("manifest", organization, publicApp); }} />
            </section>}
            <details className="border-t pt-4"><summary className="cursor-pointer text-sm font-medium">Use an existing GitHub App</summary><ExistingAppForm busy={disabled} onSave={saveManual} /></details>
            <section className="space-y-3 border-t pt-4">
              <h2 className="text-sm font-semibold">Import deployment credentials</h2>
              <p className="text-sm text-muted-foreground">Import is a recovery action, not a connection check. It validates the environment credentials and replaces any stored app credentials.</p>
              {attributes["environment-import-available"] === true
                ? <Button variant="outline" disabled={disabled} onClick={(): void => { setImportOpen(true); }}>Import from environment…</Button>
                : <p className="text-sm text-muted-foreground">No complete GitHub App credential set is available in this process environment.</p>}
            </section>
            {(hasApp || pending) && <section className="space-y-3 border-t pt-4">
              <h2 className="text-sm font-semibold">Disconnect</h2>
              <p className="text-sm text-muted-foreground">Removes stored credentials, not the app on GitHub or workspace configuration. To delete the registration itself, use GitHub. Deleting it there uninstalls it everywhere.</p>
              <Button variant="destructive" disabled={disabled} onClick={(): void => { setDisconnectOpen(true); }}><Unplug data-icon="inline-start" />Disconnect from Terrence…</Button>
            </section>}
          </div>
        </details>
      </div>}
      <ConfirmDialog open={disconnectOpen} onOpenChange={(open): void => { if (busy === "") setDisconnectOpen(open); }} title="Disconnect GitHub App from Terrence" description="This removes stored credentials and pending setup. Workspace configuration and GitHub registrations are kept. A restart will not automatically re-import the old environment credentials." confirmText="Disconnect from Terrence" confirmVariant="destructive" requireCheckbox="I understand that GitHub-backed operations will stop until an app is connected again." loading={busy === "disconnect"} onConfirm={async (): Promise<void> => { if (await action("disconnect")) setDisconnectOpen(false); }} />
      <ConfirmDialog open={importOpen} onOpenChange={(open): void => { if (busy === "") setImportOpen(open); }} title="Import GitHub App credentials from environment" description="This replaces stored credentials and any unfinished setup with the app configured in the deployment environment. It does not migrate installations to a different app." confirmText="Validate and import" requireCheckbox="I have checked that these are the credentials I want Terrence to use." loading={busy === "import-environment"} onConfirm={async (): Promise<void> => { if (await action("import-environment")) setImportOpen(false); }} />
    </PageShell>
  );
}
