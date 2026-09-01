import { useEffect, useState } from "react";
import { fetchApi, type ReasoningEffort } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select, SelectItem } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";
import { Badge } from "../components/ui/badge";
import { FuzzyCombobox } from "../components/ui/fuzzy-combobox";
import { CalendarClock, Check, LockKeyhole, Plus, ShieldAlert, SlidersHorizontal, Sparkles, Trash2, Webhook } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";

type ApprovalWebhookSettings = {
  enabled?: boolean;
  secret?: string | null;
  "secret-set"?: boolean;
  url?: string | null;
};

type MaintenanceWindow = {
  days: number[];
  "start-time": string;
  "end-time": string;
  timezone?: string;
};

type MaintenanceWindowsSettings = {
  enabled?: boolean;
  windows?: MaintenanceWindow[];
};

type PlanExplainerSettings = {
  enabled?: boolean;
  "base-url"?: string | null;
  "api-key"?: string | null;
  "api-key-set"?: boolean;
  model?: string | null;
  provider?: string | null;
  "reasoning-effort"?: ReasoningEffort | null;
};

type LoggingSettings = {
  enabled?: boolean | null;
  "log-level"?: string | null;
  "syslog-level"?: string | null;
  "syslog-targets"?: string[] | null;
  "syslog-hostname"?: string | null;
  "syslog-app"?: string | null;
};

type ExplainerProvider = {
  id: string;
  name: string;
  "model-count": number;
};

type ExplainerModel = {
  id: string;
  name: string;
  reasoning: boolean;
  context: number | null;
};

/** Synthetic provider id for arbitrary OpenAI-compatible endpoints, always
 * listed first by the backend catalog and the default selection. */
const CUSTOM_PROVIDER_ID = "custom";

type OperationsSettings = {
  "approval-webhook"?: ApprovalWebhookSettings;
  "maintenance-windows"?: MaintenanceWindowsSettings;
  "plan-explainer"?: PlanExplainerSettings;
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_OPTIONS = DAY_LABELS.map((label, index): { day: number; label: string } => ({ day: index, label }));

function humanizeDays(days: number[]): string {
  if (days.length === 0) return "Never";
  if (days.length === 7) return "Every day";
  if (
    days.length === 5
    && DAYS_WEEKDAYS.every((day: number): boolean => days.includes(day))
  ) {
    return "Weekdays";
  }
  if (
    days.length === 2
    && DAYS_WEEKEND.every((day: number): boolean => days.includes(day))
  ) {
    return "Weekend";
  }
  return [...days].sort((a: number, b: number): number => a - b)
    .map((day: number): string => DAY_LABELS[day] ?? String(day))
    .join(", ");
}

function toggleDay(days: number[], day: number): number[] {
  return days.includes(day) ? days.filter((existing: number): boolean => existing !== day) : [...days, day].sort();
}

const DAYS_WEEKDAYS = [1, 2, 3, 4, 5];
const DAYS_WEEKEND = [0, 6];

export type AdminOperationsSection = "logging" | "maintenance" | "approval-webhook" | "plan-explainer";

export function AdminOperationsSettings({
  section,
}: Readonly<{
  section?: AdminOperationsSection;
}> = {}): React.JSX.Element {
  const [settings, setSettings] = useState<OperationsSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedAt, setSavedAt] = useState("");

  const [approvalEnabled, setApprovalEnabled] = useState(false);
  const [approvalUrl, setApprovalUrl] = useState("");
  const [approvalSecret, setApprovalSecret] = useState("");
  const [approvalSecretSet, setApprovalSecretSet] = useState(false);
  const [approvalClearSecret, setApprovalClearSecret] = useState(false);
  const [approvalSaving, setApprovalSaving] = useState(false);
  const [approvalSavedAt, setApprovalSavedAt] = useState("");
  const [approvalError, setApprovalError] = useState("");

  const [windowsEnabled, setWindowsEnabled] = useState(false);
  const [windows, setWindows] = useState<MaintenanceWindow[]>([]);
  const [maintenanceSaving, setMaintenanceSaving] = useState(false);
  const [maintenanceSavedAt, setMaintenanceSavedAt] = useState("");
  const [maintenanceError, setMaintenanceError] = useState("");

  const [explainerEnabled, setExplainerEnabled] = useState(false);
  const [explainerBaseUrl, setExplainerBaseUrl] = useState("");
  const [explainerApiKey, setExplainerApiKey] = useState("");
  const [explainerApiKeySet, setExplainerApiKeySet] = useState(false);
  const [explainerClearApiKey, setExplainerClearApiKey] = useState(false);
  const [explainerModel, setExplainerModel] = useState("");
  const [explainerProvider, setExplainerProvider] = useState(CUSTOM_PROVIDER_ID);
  const [explainerReasoningEffort, setExplainerReasoningEffort] = useState<ReasoningEffort | "">("");
  const [explainerSaving, setExplainerSaving] = useState(false);
  const [explainerSavedAt, setExplainerSavedAt] = useState("");
  const [explainerError, setExplainerError] = useState("");

  const [loggingLevel, setLoggingLevel] = useState("");
  const [loggingEnabled, setLoggingEnabled] = useState(true);
  const [loggingLoaded, setLoggingLoaded] = useState(false);
  const [syslogLevel, setSyslogLevel] = useState("");
  const [syslogTargets, setSyslogTargets] = useState("");
  const [syslogHostname, setSyslogHostname] = useState("");
  const [syslogApp, setSyslogApp] = useState("");
  const [loggingSaving, setLoggingSaving] = useState(false);
  const [loggingSavedAt, setLoggingSavedAt] = useState("");
  const [loggingError, setLoggingError] = useState("");

  // Provider/model catalog for the explainer pickers (models.dev via admin API).
  const [providers, setProviders] = useState<ExplainerProvider[]>([]);
  const [providerModels, setProviderModels] = useState<ExplainerModel[]>([]);
  const [providerCatalogError, setProviderCatalogError] = useState("");

  useEffect((): void => {
    const loadSettings = async (): Promise<void> => {
      setLoading(true);
      setLoadError("");
      try {
        const response = await fetchApi("/admin/operations-settings") as {
          data?: { attributes?: OperationsSettings };
        };
        const attributes = response.data?.attributes ?? {};
        setSettings(attributes);
        const approval = attributes["approval-webhook"] ?? {};
        setApprovalEnabled(approval.enabled === true);
        setApprovalUrl(approval.url ?? "");
        setApprovalSecret("");
        setApprovalSecretSet(approval["secret-set"] === true);
        setApprovalClearSecret(false);
        const windowsGroup = attributes["maintenance-windows"] ?? {};
        setWindowsEnabled(windowsGroup.enabled === true);
        setWindows(windowsGroup.windows ?? []);
        const explainer = attributes["plan-explainer"] ?? {};
        setExplainerEnabled(explainer.enabled === true);
        setExplainerBaseUrl(explainer["base-url"] ?? "");
        setExplainerApiKey("");
        setExplainerApiKeySet(explainer["api-key-set"] === true);
        setExplainerClearApiKey(false);
        setExplainerModel(explainer.model ?? "");
        setExplainerProvider(explainer.provider ?? CUSTOM_PROVIDER_ID);
        setExplainerReasoningEffort(explainer["reasoning-effort"] ?? "");
      } catch (caught: unknown) {
        setLoadError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    };
    void loadSettings();
  }, [loadAttempt]);

  useEffect((): void => {
    const loadLoggingSettings = async (): Promise<void> => {
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
        setLoggingLoaded(true);
      } catch (caught: unknown) {
        setLoggingError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void loadLoggingSettings();
  }, [loadAttempt]);

  useEffect((): void => {
    const loadCatalog = async (): Promise<void> => {
      try {
        const response = await fetchApi("/admin/operations-settings/explainer/providers") as {
          data?: { id: string; attributes: { name: string; "model-count": number } }[];
        };
        const list = (response.data ?? []).map((p): ExplainerProvider => ({
          id: p.id,
          name: p.attributes.name,
          "model-count": p.attributes["model-count"],
        }));
        setProviders(list);
        setProviderCatalogError("");
      } catch (caught: unknown) {
        setProviderCatalogError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void loadCatalog();
  }, []);

  useEffect((): (() => void) => {
    let cancelled = false;
    const loadModels = async (): Promise<void> => {
      if (explainerProvider === "" || explainerProvider === CUSTOM_PROVIDER_ID) {
        setProviderModels([]);
        return;
      }
      try {
        const response = await fetchApi(`/admin/operations-settings/explainer/models?provider=${encodeURIComponent(explainerProvider)}`) as {
          data?: { id: string; attributes: { name: string; reasoning: boolean; context: number | null } }[];
        };
        if (cancelled) return;
        const list = (response.data ?? []).map((m): ExplainerModel => ({
          id: m.id,
          name: m.attributes.name,
          reasoning: m.attributes.reasoning,
          context: m.attributes.context,
        }));
        setProviderModels(list);
      } catch {
        if (!cancelled) setProviderModels([]);
      }
    };
    void loadModels();
    return (): void => {
      cancelled = true;
    };
  }, [explainerProvider]);

  const updateWindow = (index: number, patch: Partial<MaintenanceWindow>): void => {
    setWindows((existing): MaintenanceWindow[] => existing.map((window, i): MaintenanceWindow => (i === index ? { ...window, ...patch } : window)));
  };

  const patchOperationsSettings = async (partialAttributes: Record<string, unknown>): Promise<void> => {
    const response = await fetchApi("/admin/operations-settings", {
      method: "PATCH",
      body: JSON.stringify({ data: { attributes: partialAttributes } }),
    }) as { data?: { attributes?: OperationsSettings } };
    const refreshed = response.data?.attributes ?? {};
    setSettings(refreshed);
  };

  const saveApprovalWebhook = async (): Promise<void> => {
    setApprovalSaving(true);
    setApprovalError("");
    setApprovalSavedAt("");
    try {
      const payload = {
        enabled: approvalEnabled,
        ...(approvalUrl !== "" ? { url: approvalUrl.trim() } : { url: null }),
        ...(approvalClearSecret ? { secret: null } : approvalSecret !== "" ? { secret: approvalSecret } : {}),
      };
      await patchOperationsSettings({ "approval-webhook": payload });
      setApprovalSavedAt(new Date().toLocaleTimeString());
      setApprovalSecret("");
      setApprovalClearSecret(false);
    } catch (caught: unknown) {
      setApprovalError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setApprovalSaving(false);
    }
  };

  const saveMaintenanceWindows = async (): Promise<void> => {
    setMaintenanceSaving(true);
    setMaintenanceError("");
    setMaintenanceSavedAt("");
    try {
      const payload = {
        enabled: windowsEnabled,
        windows: windows.map((window): MaintenanceWindow => ({
          days: [...window.days].sort(),
          "start-time": window["start-time"],
          "end-time": window["end-time"],
          ...(window.timezone !== undefined && window.timezone !== "" ? { timezone: window.timezone } : undefined),
        })),
      };
      await patchOperationsSettings({ "maintenance-windows": payload });
      setMaintenanceSavedAt(new Date().toLocaleTimeString());
    } catch (caught: unknown) {
      setMaintenanceError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMaintenanceSaving(false);
    }
  };

  const savePlanExplainer = async (): Promise<void> => {
    setExplainerSaving(true);
    setExplainerError("");
    setExplainerSavedAt("");
    try {
      const payload = {
        enabled: explainerEnabled,
        ...(explainerBaseUrl !== "" ? { "base-url": explainerBaseUrl.trim() } : { "base-url": null }),
        ...(explainerClearApiKey ? { "api-key": null } : explainerApiKey !== "" ? { "api-key": explainerApiKey } : {}),
        ...(explainerModel !== "" ? { model: explainerModel.trim() } : { model: null }),
        ...(explainerProvider !== "" ? { provider: explainerProvider } : { provider: null }),
        "reasoning-effort": explainerReasoningEffort === "" ? null : explainerReasoningEffort,
      };
      await patchOperationsSettings({ "plan-explainer": payload });
      setExplainerSavedAt(new Date().toLocaleTimeString());
    } catch (caught: unknown) {
      setExplainerError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExplainerSaving(false);
    }
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveError("");
    setSavedAt("");
    const attributes: OperationsSettings = {};
    attributes["approval-webhook"] = {
      enabled: approvalEnabled,
      ...(approvalUrl !== "" ? { url: approvalUrl.trim() } : { url: null }),
      ...(approvalClearSecret ? { secret: null } : approvalSecret !== "" ? { secret: approvalSecret } : {}),
    };
    attributes["maintenance-windows"] = {
      enabled: windowsEnabled,
      windows: windows.map((window): MaintenanceWindow => ({
        days: [...window.days].sort(),
        "start-time": window["start-time"],
        "end-time": window["end-time"],
        ...(window.timezone !== undefined && window.timezone !== "" ? { timezone: window.timezone } : undefined),
      })),
    };
    attributes["plan-explainer"] = {
      enabled: explainerEnabled,
      ...(explainerBaseUrl !== "" ? { "base-url": explainerBaseUrl.trim() } : { "base-url": null }),
      ...(explainerClearApiKey ? { "api-key": null } : explainerApiKey !== "" ? { "api-key": explainerApiKey } : {}),
      ...(explainerModel !== "" ? { model: explainerModel.trim() } : { model: null }),
      ...(explainerProvider !== "" ? { provider: explainerProvider } : { provider: null }),
      "reasoning-effort": explainerReasoningEffort === "" ? null : explainerReasoningEffort,
    };
    try {
      const response = await fetchApi("/admin/operations-settings", {
        method: "PATCH",
        body: JSON.stringify({ data: { attributes } }),
      }) as { data?: { attributes?: OperationsSettings } };
      const refreshed = response.data?.attributes ?? {};
      setSettings(refreshed);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (caught: unknown) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const saveLogging = async (): Promise<void> => {
    if (!loggingLoaded) return;
    setLoggingSaving(true);
    setLoggingError("");
    setLoggingSavedAt("");
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
      setLoggingSavedAt(new Date().toLocaleTimeString());
    } catch (caught: unknown) {
      setLoggingError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoggingSaving(false);
    }
  };

  if (loading) {
    return (
      <PageShell role="status" aria-label="Loading settings" variant="wide">
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Spinner className="size-6" />
          Loading settings…
        </div>
      </PageShell>
    );
  }

  if (loadError !== "") {
    return (
      <PageShell variant="wide">
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

  const renderLoggingCard = (): React.JSX.Element => (
    <Card>
      <CardHeader variant="section">
        <CardTitle>Logging and remote syslog</CardTitle>
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
            disabled={!loggingLoaded || loggingSaving}
            aria-label="Remote syslog"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="logging-level" className="block text-sm font-medium text-foreground">Local log level</label>
            <Select id="logging-level" value={loggingLevel} disabled={!loggingLoaded || loggingSaving} onValueChange={setLoggingLevel}>
              <SelectItem value="">Environment fallback</SelectItem>
              <SelectItem value="error">error</SelectItem>
              <SelectItem value="warn">warn</SelectItem>
              <SelectItem value="info">info</SelectItem>
              <SelectItem value="debug">debug</SelectItem>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="syslog-level" className="block text-sm font-medium text-foreground">Remote syslog level</label>
            <Select id="syslog-level" value={syslogLevel} disabled={!loggingLoaded || loggingSaving} onValueChange={setSyslogLevel}>
              <SelectItem value="">Local level fallback</SelectItem>
              <SelectItem value="error">error</SelectItem>
              <SelectItem value="warn">warn</SelectItem>
              <SelectItem value="info">info</SelectItem>
              <SelectItem value="debug">debug</SelectItem>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="syslog-targets" className="block text-sm font-medium text-foreground">Remote destinations</label>
          <Textarea
            id="syslog-targets"
            value={syslogTargets}
            disabled={!loggingLoaded || loggingSaving}
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
            <Input id="syslog-hostname" value={syslogHostname} disabled={!loggingLoaded || loggingSaving} onInput={(event): void => { setSyslogHostname(event.currentTarget.value); }} placeholder="Environment fallback" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="syslog-app" className="block text-sm font-medium text-foreground">Syslog app name</label>
            <Input id="syslog-app" value={syslogApp} disabled={!loggingLoaded || loggingSaving} onInput={(event): void => { setSyslogApp(event.currentTarget.value); }} placeholder="terrence" />
          </div>
        </div>
      </CardContent>
      <CardFooter className="justify-between">
        <span role="status" className="text-sm">
          {loggingError !== "" && <span className="text-destructive">{loggingError}</span>}
          {loggingSavedAt !== "" && <span className="text-success">Logging settings saved at {loggingSavedAt}.</span>}
        </span>
        <Button type="button" onClick={(): void => { void saveLogging(); }} disabled={!loggingLoaded || loggingSaving}>
          {loggingSaving && <Spinner data-icon="inline-start" className="size-4" />}
          {loggingSaving ? "Saving…" : "Save changes"}
        </Button>
      </CardFooter>
    </Card>
  );

  const renderApprovalCard = (): React.JSX.Element => (
    <Card>
      <CardHeader variant="section">
        <CardTitle>Approval webhook</CardTitle>
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
          {approvalError !== "" && <span className="text-destructive">{approvalError}</span>}
          {approvalSavedAt !== "" && <span className="text-success">Webhook settings saved at {approvalSavedAt}.</span>}
        </span>
        <Button type="button" onClick={(): void => { void saveApprovalWebhook(); }} disabled={approvalSaving}>
          {approvalSaving && <Spinner data-icon="inline-start" className="size-4" />}
          {approvalSaving ? "Saving…" : "Save changes"}
        </Button>
      </CardFooter>
    </Card>
  );

  const renderMaintenanceCard = (): React.JSX.Element => (
    <Card>
      <CardHeader variant="section">
        <CardTitle>Maintenance windows</CardTitle>
        <CardDescription>
          Applies are blocked during configured windows. Plans are never affected.
        </CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            <label htmlFor="maintenance-enabled" className="text-xs font-medium text-muted-foreground cursor-pointer">
              {windowsEnabled ? "Enabled" : "Disabled"}
            </label>
            <Switch id="maintenance-enabled" checked={windowsEnabled} onCheckedChange={setWindowsEnabled} aria-label="Maintenance windows" />
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>
        {windows.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-muted/30 px-4 py-8 text-center">
            <p className="text-sm font-medium text-foreground">No maintenance windows yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Add a window when applies need a predictable pause.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {windows.map((window, index): React.JSX.Element => (
              <div key={index} className="rounded-lg border bg-card p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-foreground">Window {index + 1}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10"
                    onClick={(): void => { setWindows((existing): MaintenanceWindow[] => existing.filter((_, i): boolean => i !== index)); }}
                    aria-label={`Remove window ${index + 1}`}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-foreground">Active days</label>
                    <span className="text-xs font-medium text-muted-foreground">{humanizeDays(window.days)}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {DAY_OPTIONS.map((option): React.JSX.Element => {
                      const selected = window.days.includes(option.day);
                      return (
                        <Button
                          key={option.day}
                          type="button"
                          size="sm"
                          variant={selected ? "default" : "outline"}
                          className="h-7 px-2.5 text-xs font-normal"
                          onClick={(): void => { updateWindow(index, { days: toggleDay(window.days, option.day) }); }}
                        >
                          {option.label}
                        </Button>
                      );
                    })}
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <label htmlFor={`window-${index}-start`} className="text-xs font-medium text-foreground">Start time (UTC)</label>
                    <Input
                      id={`window-${index}-start`}
                      name={`window-${index}-start-time`}
                      type="time"
                      value={window["start-time"]}
                      onChange={(event): void => { updateWindow(index, { "start-time": event.target.value }); }}
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`window-${index}-end`} className="text-xs font-medium text-foreground">End time (UTC)</label>
                    <Input
                      id={`window-${index}-end`}
                      name={`window-${index}-end-time`}
                      type="time"
                      value={window["end-time"]}
                      onChange={(event): void => { updateWindow(index, { "end-time": event.target.value }); }}
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`window-${index}-timezone`} className="text-xs font-medium text-foreground">Timezone (optional)</label>
                    <Input
                      id={`window-${index}-timezone`}
                      name={`window-${index}-timezone`}
                      value={window.timezone ?? ""}
                      placeholder="UTC"
                      onChange={(event): void => { updateWindow(index, { timezone: event.target.value }); }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={(): void => {
            setWindows((existing): MaintenanceWindow[] => [
              ...existing,
              { days: [0, 6], "start-time": "00:00", "end-time": "04:00" },
            ]);
          }}
        >
          <Plus data-icon="inline-start" className="size-4" />
          Add maintenance window
        </Button>
      </CardContent>
      <CardFooter className="justify-between">
        <span role="status" className="text-sm">
          {maintenanceError !== "" && <span className="text-destructive">{maintenanceError}</span>}
          {maintenanceSavedAt !== "" && <span className="text-success">Maintenance settings saved at {maintenanceSavedAt}.</span>}
        </span>
        <Button type="button" onClick={(): void => { void saveMaintenanceWindows(); }} disabled={maintenanceSaving}>
          {maintenanceSaving && <Spinner data-icon="inline-start" className="size-4" />}
          {maintenanceSaving ? "Saving…" : "Save changes"}
        </Button>
      </CardFooter>
    </Card>
  );

  const renderExplainerCard = (): React.JSX.Element => (
    <Card>
      <CardHeader variant="section">
        <CardTitle>AI plan explainer</CardTitle>
        <CardDescription>
          Generate plain-language plan summaries. Powered by any OpenAI-compatible API or models.dev provider.
        </CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            <label htmlFor="explainer-enabled" className="text-xs font-medium text-muted-foreground cursor-pointer">
              {explainerEnabled ? "Enabled" : "Disabled"}
            </label>
            <Switch id="explainer-enabled" checked={explainerEnabled} onCheckedChange={setExplainerEnabled} aria-label="Plan explainer" />
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="explainer-provider" className="block text-sm font-medium text-foreground">
              Provider
            </label>
            {providers.length > 0 ? (
              <FuzzyCombobox
                id="explainer-provider"
                options={providers.map((p): { id: string; label: string; hint?: string } => ({
                  id: p.id,
                  label: p.name,
                  ...(p["model-count"] > 0 ? { hint: `${p["model-count"]} models` } : {}),
                }))}
                value={explainerProvider}
                onSelect={(id): void => {
                  setExplainerProvider(id);
                  setExplainerModel("");
                }}
                placeholder="Select a provider…"
                emptyText="No provider found. Use Custom for arbitrary endpoints."
                allowCustom
                className="w-full"
              />
            ) : (
              <Input
                id="explainer-provider"
                name="explainer-provider"
                value={explainerProvider}
                onChange={(event): void => { setExplainerProvider(event.target.value); }}
                placeholder="custom"
              />
            )}
            <p className="text-xs text-muted-foreground">
              {explainerProvider === CUSTOM_PROVIDER_ID
                ? "Custom endpoint — enter any OpenAI-compatible base URL below."
                : "Standard provider catalog from models.dev."}
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="explainer-model" className="block text-sm font-medium text-foreground">
              Model
            </label>
            {providerModels.length > 0 ? (
              <FuzzyCombobox
                id="explainer-model"
                options={providerModels.map((m): { id: string; label: string; hint?: string } => {
                  const hintText = [
                    m.reasoning ? "reasoning" : undefined,
                    m.context !== null ? `${Math.round(m.context / 1000)}k ctx` : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return {
                    id: m.id,
                    label: m.name,
                    ...(hintText !== "" ? { hint: hintText } : {}),
                  };
                })}
                value={explainerModel}
                onSelect={(id): void => { setExplainerModel(id); }}
                placeholder="Select a model…"
                emptyText="No model found. Enter a model ID manually."
                allowCustom
                className="w-full"
              />
            ) : (
              <Input
                id="explainer-model"
                name="explainer-model"
                value={explainerModel}
                onChange={(event): void => { setExplainerModel(event.target.value); }}
                placeholder="e.g. gpt-4o, claude-3-7-sonnet"
              />
            )}
            <p className="text-xs text-muted-foreground">Model identifier sent in chat completions requests.</p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="explainer-reasoning-effort" className="block text-sm font-medium text-foreground">
              Reasoning effort
            </label>
            <Select
              id="explainer-reasoning-effort"
              value={explainerReasoningEffort}
              onValueChange={(val: string): void => { setExplainerReasoningEffort(val as ReasoningEffort | ""); }}
            >
              <SelectItem value="">Default</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </Select>
            <p className="text-xs text-muted-foreground">
              Only applies to reasoning models (e.g. o1, o3-mini). Ignored by non-reasoning models.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="explainer-base-url" className="block text-sm font-medium text-foreground">
              Base URL (optional)
            </label>
            <Input
              id="explainer-base-url"
              name="explainer-base-url"
              autoComplete="url"
              value={explainerBaseUrl}
              onInput={(event): void => { setExplainerBaseUrl(event.currentTarget.value); }}
              placeholder={explainerProvider === CUSTOM_PROVIDER_ID ? "https://your-llm-host.example.com/v1" : "Leave blank for provider default"}
              aria-describedby="explainer-base-url-help"
            />
            <p id="explainer-base-url-help" className="text-xs text-muted-foreground">
              {explainerProvider === CUSTOM_PROVIDER_ID
                ? "Required for the custom provider. The chat completions path is added automatically."
                : "Leave blank to use the selected provider’s models.dev URL. The chat completions path is added automatically."}
            </p>
          </div>
        </div>

        <div className="max-w-2xl space-y-1.5">
          <label htmlFor="explainer-api-key" className="block text-sm font-medium text-foreground">
            API key
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="explainer-api-key"
              name="explainer-api-key"
              autoComplete="new-password"
              type="password"
              value={explainerApiKey}
              onInput={(event): void => {
                setExplainerApiKey(event.currentTarget.value);
                setExplainerClearApiKey(false);
              }}
              placeholder={explainerApiKeySet ? "•••••••• (a key is stored)" : "Optional bearer token"}
              className="flex-1 font-mono"
            />
            {explainerApiKeySet && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={(): void => {
                  setExplainerApiKey("");
                  setExplainerClearApiKey(true);
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
        {providerCatalogError !== "" && (
          <p className="text-xs text-destructive">
            Provider catalog unavailable ({providerCatalogError}). Enter the provider, model, and base URL manually.
          </p>
        )}
      </CardContent>
      <CardFooter className="justify-between">
        <span role="status" className="text-sm">
          {explainerError !== "" && <span className="text-destructive">{explainerError}</span>}
          {explainerSavedAt !== "" && <span className="text-success">Explainer settings saved at {explainerSavedAt}.</span>}
        </span>
        <Button type="button" onClick={(): void => { void savePlanExplainer(); }} disabled={explainerSaving}>
          {explainerSaving && <Spinner data-icon="inline-start" className="size-4" />}
          {explainerSaving ? "Saving…" : "Save changes"}
        </Button>
      </CardFooter>
    </Card>
  );

  if (section === "logging") {
    return (
      <PageShell variant="wide">
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
        <div className="space-y-6">
          {renderLoggingCard()}
        </div>
      </PageShell>
    );
  }

  if (section === "maintenance") {
    return (
      <PageShell variant="wide">
        <PageHeader
          eyebrow="Site administration"
          title={(
            <span className="flex items-center gap-2">
              <CalendarClock className="size-7 text-primary" aria-hidden="true" />
              Maintenance windows
            </span>
          )}
          description="Restrict automatic runs and workspace updates to scheduled maintenance periods."
        />
        <div className="space-y-6">
          {renderMaintenanceCard()}
        </div>
      </PageShell>
    );
  }

  if (section === "approval-webhook") {
    return (
      <PageShell variant="wide">
        <PageHeader
          eyebrow="Site administration"
          title={(
            <span className="flex items-center gap-2">
              <Webhook className="size-7 text-primary" aria-hidden="true" />
              Approval webhook
            </span>
          )}
          description="Deliver HMAC-signed payloads for external run gate approvals."
        />
        <div className="space-y-6">
          {renderApprovalCard()}
        </div>
      </PageShell>
    );
  }

  if (section === "plan-explainer") {
    return (
      <PageShell variant="wide">
        <PageHeader
          eyebrow="Site administration"
          title={(
            <span className="flex items-center gap-2">
              <Sparkles className="size-7 text-primary" aria-hidden="true" />
              AI plan explainer
            </span>
          )}
          description="Summarize Terraform and OpenTofu execution plans using language models."
        />
        <div className="space-y-6">
          {renderExplainerCard()}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell variant="wide">
      <PageHeader
        eyebrow="Site administration"
        title={(
          <span className="flex items-center gap-2">
            <ShieldAlert className="size-7 text-primary" aria-hidden="true" />
            Operations
          </span>
        )}
        description="Control logging, approvals, maintenance windows, and plain-language plan explanations."
      />

      <div className="space-y-6">
        {renderLoggingCard()}
        {renderApprovalCard()}
        {renderMaintenanceCard()}
        {renderExplainerCard()}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
        <Button type="button" onClick={(): void => { void save(); }} disabled={saving}>
          {saving ? <Spinner data-icon="inline-start" className="size-4" /> : <Check data-icon="inline-start" className="size-4" />}
          {saving ? "Saving…" : "Save operations settings"}
        </Button>
        {savedAt !== "" && <span className="text-sm text-success" role="status" aria-live="polite">Saved at {savedAt}</span>}
        {saveError !== "" && <span className="text-sm text-destructive" role="alert">{saveError}</span>}
        {settings !== null && (
          <Badge variant="secondary" className="ml-auto">
            <LockKeyhole data-icon="inline-start" className="size-3" aria-hidden="true" />
            Read-only fields are hidden; values are stored encrypted where applicable.
          </Badge>
        )}
      </div>
    </PageShell>
  );
}
