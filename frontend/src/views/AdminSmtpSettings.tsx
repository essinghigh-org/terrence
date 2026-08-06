import { useEffect, useRef, useState } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectItem } from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { Mail } from "lucide-react";

type SmtpAttributes = {
  enabled?: boolean;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
  "sender-email"?: string | null;
  auth?: string | null;
};

const AUTH_OPTIONS: readonly Readonly<{ value: string; label: string }>[] = [
  { value: "none", label: "None" },
  { value: "plain", label: "Plain" },
  { value: "login", label: "Login" },
];

export function AdminSmtpSettings(): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("25");
  const [senderEmail, setSenderEmail] = useState("");
  const [auth, setAuth] = useState("plain");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [testEmail, setTestEmail] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);

  const mounted = useRef(true);

  const load = async (): Promise<void> => {
    setLoadError("");
    try {
      const response = await fetchApi("/admin/smtp-settings") as {
        data?: { attributes?: SmtpAttributes };
      };
      if (!mounted.current) return;
      const attrs = response.data?.attributes;
      setEnabled(attrs?.enabled === true);
      setHost(typeof attrs?.host === "string" ? attrs.host : "");
      setPort(attrs !== undefined && typeof attrs.port === "number" ? String(attrs.port) : "25");
      setSenderEmail(typeof attrs?.["sender-email"] === "string" ? attrs["sender-email"] : "");
      setAuth(typeof attrs?.auth === "string" && attrs.auth !== "" ? attrs.auth : "plain");
      setUsername(typeof attrs?.username === "string" ? attrs.username : "");
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
    setSaved(false);
    setSaving(true);
    try {
      const portNumber = Number(port);
      if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
        setSaveError("Port must be an integer between 1 and 65535.");
        return;
      }
      const attributes: Record<string, unknown> = {
        enabled,
        host: host.trim(),
        port: portNumber,
        "sender-email": senderEmail.trim(),
        auth,
        username: username.trim(),
      };
      if (password.trim() !== "") {
        attributes["password"] = password;
      }
      if (testEmail.trim() !== "") {
        attributes["test-email-address"] = testEmail.trim();
      }
      await fetchApi("/admin/smtp-settings", {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            type: "smtp-settings",
            attributes,
          },
        }),
      });
      setPassword("");
      setTestEmail("");
      setSaved(true);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "Failed to save SMTP settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <Mail className="mt-0.5 h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">SMTP settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure the outbound email server used by this installation.
          </p>
        </div>
      </div>

      <Card>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : loadError !== "" ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{loadError}</div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between rounded-md border p-3">
                <div className="text-sm">
                  <div className="font-medium">Enabled</div>
                  <div className="text-muted-foreground">
                    When enabled, Terrence sends outbound email through this SMTP server.
                  </div>
                </div>
                <Checkbox
                  checked={enabled}
                  onCheckedChange={(checked: boolean | "indeterminate"): void => { setEnabled(checked === true); }}
                  aria-label="Enabled"
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="smtp-host">Host</label>
                  <Input id="smtp-host" value={host} onChange={(e): void => { setHost(e.target.value); }} placeholder="smtp.example.com" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="smtp-port">Port</label>
                  <Input id="smtp-port" type="number" value={port} onChange={(e): void => { setPort(e.target.value); }} placeholder="25" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="smtp-sender">Sender email</label>
                  <Input id="smtp-sender" value={senderEmail} onChange={(e): void => { setSenderEmail(e.target.value); }} placeholder="noreply@example.com" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="smtp-auth">Auth type</label>
                  <Select id="smtp-auth" value={auth} onValueChange={setAuth}>
                    {AUTH_OPTIONS.map((option): React.JSX.Element => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="smtp-username">Username</label>
                  <Input id="smtp-username" value={username} onChange={(e): void => { setUsername(e.target.value); }} placeholder="SMTP username" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="smtp-password">Password</label>
                  <Input id="smtp-password" type="password" value={password} onChange={(e): void => { setPassword(e.target.value); }} placeholder="Leave blank to keep current" />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <label className="text-sm font-medium" htmlFor="smtp-test-email">Send test email to</label>
                  <Input id="smtp-test-email" value={testEmail} onChange={(e): void => { setTestEmail(e.target.value); }} placeholder="ops@example.com" />
                </div>
              </div>

              {saveError !== "" && <div className="text-sm text-red-500">{saveError}</div>}
              {saved && <div className="text-sm text-green-600">Saved</div>}

              <div className="flex justify-end">
                <Button onClick={save} disabled={saving || loading}>
                  {saving ? <Spinner /> : "Save"}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}