import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import { formatDateTime } from "@/lib/utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select, SelectItem } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";
import { SlidersHorizontal } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";

type LoggingSettings = {
  enabled?: boolean | null;
  "log-level"?: string | null;
  "syslog-level"?: string | null;
  "syslog-targets"?: string[] | null;
  "syslog-hostname"?: string | null;
  "syslog-app"?: string | null;
  "syslog-format"?: string | null;
};

export function AdminLoggingSettings(): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  const [loggingLevel, setLoggingLevel] = useState("");
  const [loggingEnabled, setLoggingEnabled] = useState(true);
  const [loggingLoaded, setLoggingLoaded] = useState(false);
  const [syslogLevel, setSyslogLevel] = useState("");
  const [syslogTargets, setSyslogTargets] = useState("");
  const [syslogHostname, setSyslogHostname] = useState("");
  const [syslogApp, setSyslogApp] = useState("");
  const [syslogFormat, setSyslogFormat] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState("");
  const [saveError, setSaveError] = useState("");

  useEffect((): void => {
    const loadLoggingSettings = async (): Promise<void> => {
      setLoading(true);
      setLoadError("");
      setLoggingLoaded(false);
      try {
        const response = await fetchApi("/admin/logging-settings") as { data?: { attributes?: LoggingSettings } };
        const logging = response.data?.attributes ?? {};
        setLoggingEnabled(logging.enabled !== false);
        setLoggingLevel(logging["log-level"] ?? "");
        setSyslogLevel(logging["syslog-level"] ?? "");
        setSyslogTargets((logging["syslog-targets"] ?? []).join("\n"));
        setSyslogHostname(logging["syslog-hostname"] ?? "");
        setSyslogApp(logging["syslog-app"] ?? "");
        setSyslogFormat(logging["syslog-format"] ?? "");
        setLoggingLoaded(true);
      } catch (caught: unknown) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setLoadError(message);
      } finally {
        setLoading(false);
      }
    };
    void loadLoggingSettings();
  }, [loadAttempt]);

  const saveLogging = async (): Promise<void> => {
    if (!loggingLoaded) return;
    setSaving(true);
    setSaveError("");
    setSavedAt("");
    const targets = syslogTargets.split(/[\r\n,]+/u).map((target): string => target.trim()).filter(Boolean);
    try {
      const response = await fetchApi("/admin/logging-settings", {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            attributes: {
              enabled: loggingEnabled,
              "log-level": loggingLevel === "" ? null : loggingLevel,
              "syslog-level": syslogLevel === "" ? null : syslogLevel,
              "syslog-targets": targets.length === 0 ? null : targets,
              "syslog-hostname": syslogHostname === "" ? null : syslogHostname,
              "syslog-app": syslogApp === "" ? null : syslogApp,
              "syslog-format": syslogFormat === "" ? null : syslogFormat,
            },
          },
        }),
      }) as { data?: { attributes?: LoggingSettings } };
      const logging = response.data?.attributes ?? {};
      setLoggingEnabled(logging.enabled !== false);
      setLoggingLevel(logging["log-level"] ?? "");
      setSyslogLevel(logging["syslog-level"] ?? "");
      setSyslogTargets((logging["syslog-targets"] ?? []).join("\n"));
      setSyslogHostname(logging["syslog-hostname"] ?? "");
      setSyslogApp(logging["syslog-app"] ?? "");
      setSyslogFormat(logging["syslog-format"] ?? "");
      setSavedAt(formatDateTime(new Date()));
    } catch (caught: unknown) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <PageShell role="status" aria-label="Loading logging settings" variant="form">
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Spinner className="size-6" />
          Loading logging settings…
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
            <SlidersHorizontal className="size-7 text-primary" aria-hidden="true" />
            Logging
          </span>
        )}
        description="Configure local log levels and remote syslog collector forwarding."
      />

      <Card>
        <CardHeader variant="section">
          <CardTitle>Log levels and remote syslog</CardTitle>
          <CardDescription>
            Site admin values override environment variables. Leave a field empty to keep its environment fallback.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-border bg-muted/20 p-3.5">
            <div className="space-y-0.5">
              <label htmlFor="logging-enabled" className="text-sm font-medium text-foreground cursor-pointer">
                Remote syslog forwarding
              </label>
              <p className="text-xs text-muted-foreground">
                {loggingEnabled ? "Enabled" : "Disabled"} · Stream system events and run output to remote syslog destinations
              </p>
            </div>
            <Switch
              id="logging-enabled"
              checked={loggingEnabled}
              onCheckedChange={setLoggingEnabled}
              disabled={!loggingLoaded || saving}
              aria-label="Remote syslog"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="logging-level" className="block text-sm font-medium text-foreground">Local log level</label>
              <Select id="logging-level" value={loggingLevel} disabled={!loggingLoaded || saving} onValueChange={setLoggingLevel}>
                <SelectItem value="">Environment fallback</SelectItem>
                <SelectItem value="error">error</SelectItem>
                <SelectItem value="warn">warn</SelectItem>
                <SelectItem value="info">info</SelectItem>
                <SelectItem value="debug">debug</SelectItem>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="syslog-level" className="block text-sm font-medium text-foreground">Remote syslog level</label>
              <Select id="syslog-level" value={syslogLevel} disabled={!loggingLoaded || saving} onValueChange={setSyslogLevel}>
                <SelectItem value="">Local level fallback</SelectItem>
                <SelectItem value="error">error</SelectItem>
                <SelectItem value="warn">warn</SelectItem>
                <SelectItem value="info">info</SelectItem>
                <SelectItem value="debug">debug</SelectItem>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="syslog-format" className="block text-sm font-medium text-foreground">Syslog message format</label>
            <Select id="syslog-format" value={syslogFormat} disabled={!loggingLoaded || saving} onValueChange={setSyslogFormat}>
              <SelectItem value="">Environment fallback</SelectItem>
              <SelectItem value="rfc5424">RFC 5424 structured data</SelectItem>
              <SelectItem value="json">JSON message body</SelectItem>
            </Select>
            <p className="text-xs text-muted-foreground">JSON bodies auto-extract in Splunk (sourcetype json); RFC 5424 structured data suits syslog-native collectors. Empty uses TERRENCE_SYSLOG_FORMAT (default rfc5424).</p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="syslog-targets" className="block text-sm font-medium text-foreground">Remote destinations</label>
            <Textarea
              id="syslog-targets"
              value={syslogTargets}
              disabled={!loggingLoaded || saving}
              onInput={(event): void => { setSyslogTargets(event.currentTarget.value); }}
              placeholder={"udp://collector.example.com:514\ntcp://collector.example.com:601"}
              rows={3}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">One udp:// or tcp:// destination per line. An empty value uses TERRENCE_SYSLOG_TARGET(S).</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="syslog-hostname" className="block text-sm font-medium text-foreground">Syslog hostname (optional)</label>
              <Input id="syslog-hostname" value={syslogHostname} disabled={!loggingLoaded || saving} onInput={(event): void => { setSyslogHostname(event.currentTarget.value); }} placeholder="Environment fallback" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="syslog-app" className="block text-sm font-medium text-foreground">Syslog app name</label>
              <Input id="syslog-app" value={syslogApp} disabled={!loggingLoaded || saving} onInput={(event): void => { setSyslogApp(event.currentTarget.value); }} placeholder="terrence" />
            </div>
          </div>
        </CardContent>
        <CardFooter className="justify-between">
          <span role="status" className="text-sm">
            {saveError !== "" && <span className="text-destructive">{saveError}</span>}
            {savedAt !== "" && <span className="text-success">Logging settings saved at {savedAt}.</span>}
          </span>
          <Button type="button" onClick={(): void => { void saveLogging(); }} disabled={!loggingLoaded || saving}>
            {saving && <Spinner data-icon="inline-start" className="size-4" />}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </CardFooter>
      </Card>
    </PageShell>
  );
}
