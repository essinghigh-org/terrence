import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import { formatDateTime } from "@/lib/utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";
import { Webhook } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";

type ApprovalWebhookSettings = {
  enabled?: boolean;
  secret?: string | null;
  "secret-set"?: boolean;
  url?: string | null;
};

type OperationsSettings = {
  "approval-webhook"?: ApprovalWebhookSettings;
};

export function AdminApprovalWebhook(): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  const [approvalEnabled, setApprovalEnabled] = useState(false);
  const [approvalUrl, setApprovalUrl] = useState("");
  const [approvalSecret, setApprovalSecret] = useState("");
  const [approvalSecretSet, setApprovalSecretSet] = useState(false);
  const [approvalClearSecret, setApprovalClearSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState("");
  const [saveError, setSaveError] = useState("");

  useEffect((): void => {
    const loadSettings = async (): Promise<void> => {
      setLoading(true);
      setLoadError("");
      try {
        const response = await fetchApi("/admin/operations-settings") as {
          data?: { attributes?: OperationsSettings };
        };
        const attributes = response.data?.attributes ?? {};
        const approval = attributes["approval-webhook"] ?? {};
        setApprovalEnabled(approval.enabled === true);
        setApprovalUrl(approval.url ?? "");
        setApprovalSecret("");
        setApprovalSecretSet(approval["secret-set"] === true);
        setApprovalClearSecret(false);
      } catch (caught: unknown) {
        setLoadError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    };
    void loadSettings();
  }, [loadAttempt]);

  const saveApprovalWebhook = async (): Promise<void> => {
    setSaving(true);
    setSaveError("");
    setSavedAt("");
    try {
      const trimmedUrl = approvalUrl.trim();
      const payload = {
        enabled: approvalEnabled,
        ...(trimmedUrl !== "" ? { url: trimmedUrl } : { url: null }),
        ...(approvalClearSecret ? { secret: null } : approvalSecret !== "" ? { secret: approvalSecret } : {}),
      };
      await fetchApi("/admin/operations-settings", {
        method: "PATCH",
        body: JSON.stringify({ data: { attributes: { "approval-webhook": payload } } }),
      });
      setSavedAt(formatDateTime(new Date()));
      setApprovalSecret("");
      setApprovalClearSecret(false);
      setApprovalSecretSet(approvalSecret !== "" || (approvalSecretSet && !approvalClearSecret));
    } catch (caught: unknown) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <PageShell role="status" aria-label="Loading approval webhook settings" variant="form">
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Spinner className="size-6" />
          Loading approval webhook settings…
        </div>
      </PageShell>
    );
  }

  if (loadError !== "") {
    return (
      <PageShell variant="form">
        <Card>
          <CardContent role="alert" className="flex flex-wrap items-center justify-between gap-3 py-8 text-sm text-destructive">
            <span>{loadError}</span>
            <Button type="button" size="sm" variant="outline" onClick={(): void => { setLoadAttempt((attempt): number => attempt + 1); }} disabled={loading}>
              Try again
            </Button>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell variant="form">
      <PageHeader
        eyebrow="Site administration"
        title={(
          <span className="flex items-center gap-2">
            <Webhook className="size-7 text-primary" aria-hidden="true" />
            Approval webhook
          </span>
        )}
        description="Allow external systems to approve runs using HMAC-signed webhook requests."
      />

      <Card>
        <CardHeader variant="section">
          <CardTitle>Webhook configuration</CardTitle>
          <CardDescription>
            External systems can confirm a run by POSTing {"{ run_id, action: \"confirm\" }"} to{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">/api/v2/webhooks/run-approval</code> with an
            HMAC-SHA256 signature in <code className="rounded bg-muted px-1 py-0.5 text-xs">X-Terrence-Signature</code>.
          </CardDescription>
          <CardAction>
            <div className="flex items-center gap-2">
              <label htmlFor="approval-enabled" className="text-xs font-medium text-muted-foreground cursor-pointer">
                {approvalEnabled ? "Enabled" : "Disabled"}
              </label>
              <Switch id="approval-enabled" checked={approvalEnabled} onCheckedChange={setApprovalEnabled} aria-label="Approval webhook" />
            </div>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="approval-url" className="block text-sm font-medium text-foreground">
              Callback URL (optional)
            </label>
            <Input
              id="approval-url"
              name="approval-callback-url"
              autoComplete="url"
              value={approvalUrl}
              onInput={(event): void => { setApprovalUrl(event.currentTarget.value); }}
              placeholder="https://example.com/hooks/terrence-approval"
              className="max-w-xl"
            />
            <p className="text-xs text-muted-foreground">
              If set, a signed confirmation notification is sent to this URL after a successful approval.
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="approval-secret" className="block text-sm font-medium text-foreground">
              Shared secret
            </label>
            <div className="flex max-w-xl items-center gap-2">
              <Input
                id="approval-secret"
                name="approval-shared-secret"
                autoComplete="new-password"
                type="password"
                value={approvalSecret}
                onInput={(event): void => {
                  setApprovalSecret(event.currentTarget.value);
                  setApprovalClearSecret(false);
                }}
                placeholder={approvalSecretSet ? "•••••••• (a secret is stored)" : "HMAC-SHA256 secret for request signatures"}
                className="flex-1"
              />
              {approvalSecretSet && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={(): void => {
                    setApprovalSecret("");
                    setApprovalClearSecret(true);
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Required to verify incoming approval requests. Leave blank to keep the stored secret.
            </p>
          </div>
        </CardContent>
        <CardFooter className="justify-between">
          <span role="status" className="text-sm">
            {saveError !== "" && <span className="text-destructive">{saveError}</span>}
            {savedAt !== "" && <span className="text-success">Webhook settings saved at {savedAt}.</span>}
          </span>
          <Button type="button" onClick={(): void => { void saveApprovalWebhook(); }} disabled={saving}>
            {saving && <Spinner data-icon="inline-start" className="size-4" />}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </CardFooter>
      </Card>
    </PageShell>
  );
}
