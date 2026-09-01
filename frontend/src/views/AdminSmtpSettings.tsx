import { useEffect, useRef, useState } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectItem } from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { Mail } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";
import { isNumber, isString } from "../lib/type-guards";

type SmtpAttributes = {
  enabled?: boolean;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
  "sender-email"?: string | null;
  auth?: string | null;
  encryption?: string | null;
};

const AUTH_OPTIONS: readonly Readonly<{ value: string; label: string }>[] = [
  { value: "none", label: "None" },
  { value: "plain", label: "Plain" },
  { value: "login", label: "Login" },
];
const ENCRYPTION_OPTIONS: readonly Readonly<{ value: string; label: string }>[] = [
  { value: "starttls", label: "STARTTLS (required)" },
  { value: "tls", label: "Implicit TLS" },
  { value: "plain", label: "Plaintext (insecure)" },
];

export function AdminSmtpSettings(): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("25");
  const [senderEmail, setSenderEmail] = useState("");
  const [auth, setAuth] = useState("plain");
  const [encryption, setEncryption] = useState("starttls");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [testEmail, setTestEmail] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [testError, setTestError] = useState("");
  const [saved, setSaved] = useState(false);

  const mounted = useRef(true);

  const load = async (): Promise<void> => {
    setLoading(true);
    setLoadError("");
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi("/admin/smtp-settings") as {
        data?: { attributes?: SmtpAttributes };
      };
      if (!mounted.current) return;
      const attrs = response.data?.attributes;
      setEnabled(attrs?.enabled === true);
      setHost(isString(attrs?.host) ? attrs.host : "");
      const loadedPort = attrs !== undefined && isNumber(attrs.port) ? attrs.port : 25;
      setPort(String(loadedPort));
      const senderEmail = attrs?.["sender-email"];
      setSenderEmail(isString(senderEmail) ? senderEmail : "");
      setAuth(isString(attrs?.auth) && attrs.auth !== "" ? attrs.auth : "plain");
      const loadedEncryption = attrs?.encryption;
      setEncryption(
        isString(loadedEncryption) && ENCRYPTION_OPTIONS.some((option): boolean => option.value === loadedEncryption)
          ? loadedEncryption
          : loadedPort === 465 ? "tls" : "starttls",
      );
      setUsername(isString(attrs?.username) ? attrs.username : "");
      setPassword("");
      setTestEmail("");
    } catch (reason) {
      if (mounted.current) {
        setLoadError(reason instanceof Error ? reason.message : "Failed to load SMTP settings.");
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  };

  useEffect((): (() => void) => {
    mounted.current = true;
    void load();
    return (): void => {
      mounted.current = false;
    };
  }, []);

  const save = async (): Promise<void> => {
    setSaveError("");
    setTestError("");
    setSaved(false);
    setSaving(true);
    try {
      const portNumber = Number(port);
      if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
        setSaveError("Port must be an integer between 1 and 65535.");
        return;
      }
      const attributes = {
        enabled,
        host: host.trim(),
        port: portNumber,
        "sender-email": senderEmail.trim(),
        auth,
        encryption,
        username: username.trim(),
        ...(password.trim() !== "" ? { password } : undefined),
      };
      await fetchApi("/admin/smtp-settings", {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            type: "smtp-settings",
            attributes,
          },
        }),
      });
      setSaved(true);
      setPassword("");
      const recipient = testEmail.trim();
      setTestEmail("");
      if (recipient !== "") {
        try {
          await fetchApi("/admin/smtp-settings/test", {
            method: "POST",
            body: JSON.stringify({ data: { type: "smtp-test", attributes: { email: recipient } } }),
          });
        } catch (reason) {
          setTestError(reason instanceof Error ? reason.message : "SMTP settings were saved, but the test email failed.");
        }
      }
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "Failed to save SMTP settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageShell variant="form">
      <PageHeader
        eyebrow="Site administration"
        title={<span className="flex items-center gap-2"><Mail className="size-7 text-primary" aria-hidden="true" />SMTP settings</span>}
        description="Configure the outbound email server used by this installation."
      />

      <Card>
        <CardHeader variant="section">
          <CardTitle>SMTP connection</CardTitle>
          <CardDescription>Use a dedicated mail server for notifications, invitations, and other outbound email.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Spinner />
              Loading SMTP settings…
            </div>
          ) : loadError !== "" ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              <span>{loadError}</span>
              <Button type="button" size="sm" variant="outline" onClick={(): void => { void load(); }} disabled={loading}>Try again</Button>
            </div>
          ) : (
            <form onSubmit={(event): void => { event.preventDefault(); void save(); }} className="space-y-4">
              <label htmlFor="smtp-enabled" className="flex cursor-pointer items-center justify-between rounded-md border p-3 transition-colors hover:bg-muted/40">
                <div className="text-sm">
                  <div className="font-medium">Enabled</div>
                  <div className="text-muted-foreground">
                    When enabled, Terrence sends outbound email through this SMTP server.
                  </div>
                </div>
                <Checkbox
                  id="smtp-enabled"
                  checked={enabled}
                  onCheckedChange={(checked: boolean | "indeterminate"): void => { setEnabled(checked === true); }}
                  aria-label="Enabled"
                />
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="smtp-host">Host</label>
                  <Input id="smtp-host" name="host" autoComplete="url" value={host} onChange={(e): void => { setHost(e.target.value); }} placeholder="smtp.example.com" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="smtp-port">Port</label>
                  <Input id="smtp-port" name="port" type="number" inputMode="numeric" value={port} onChange={(e): void => { setPort(e.target.value); }} placeholder="25" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="smtp-sender">Sender email</label>
                  <Input id="smtp-sender" name="sender-email" type="email" autoComplete="email" value={senderEmail} onChange={(e): void => { setSenderEmail(e.target.value); }} placeholder="noreply@example.com" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="smtp-auth">Auth type</label>
                  <Select id="smtp-auth" name="auth-type" value={auth} onValueChange={setAuth}>
                    {AUTH_OPTIONS.map((option): React.JSX.Element => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="smtp-encryption">Encryption</label>
                  <Select id="smtp-encryption" name="encryption" value={encryption} onValueChange={setEncryption}>
                    {ENCRYPTION_OPTIONS.map((option): React.JSX.Element => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </Select>
                  <p className="text-xs text-muted-foreground">STARTTLS is required by default. Use implicit TLS for port 465.</p>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="smtp-username">Username</label>
                  <Input id="smtp-username" name="username" autoComplete="username" value={username} onChange={(e): void => { setUsername(e.target.value); }} placeholder="SMTP username" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="smtp-password">Password</label>
                  <Input id="smtp-password" name="password" autoComplete="new-password" type="password" value={password} onChange={(e): void => { setPassword(e.target.value); }} placeholder="Leave blank to keep current…" />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <label className="text-sm font-medium" htmlFor="smtp-test-email">Send test email to</label>
                  <Input id="smtp-test-email" name="test-email" type="email" autoComplete="email" value={testEmail} onChange={(e): void => { setTestEmail(e.target.value); }} placeholder="ops@example.com" />
                </div>
              </div>

              {encryption === "plain" && (
                <div role="alert" className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning-foreground">
                  Plaintext SMTP is insecure. Use this only with a trusted local relay; credentials are not protected in transit.
                </div>
              )}
              {saveError !== "" && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{saveError}</div>}
              {testError !== "" && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{testError}</div>}
              {saved && <div role="status" aria-live="polite" className="text-sm text-success">Saved</div>}

              <div className="flex justify-end">
                <Button type="submit" disabled={saving || loading}>
                  {saving ? <Spinner data-icon="inline-start" /> : null}
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}
