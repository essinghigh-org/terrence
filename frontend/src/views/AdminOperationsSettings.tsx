import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";
import { Badge } from "../components/ui/badge";
import { Check, Plus, ShieldAlert, Trash2, X } from "lucide-react";

type ApprovalWebhookSettings = {
  enabled?: boolean;
  secret?: string;
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
  "endpoint-url"?: string | null;
  "api-key"?: string | null;
  model?: string | null;
};

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

const DAYS_ALL = [0, 1, 2, 3, 4, 5, 6];
const DAYS_WEEKDAYS = [1, 2, 3, 4, 5];
const DAYS_WEEKEND = [0, 6];

export function AdminOperationsSettings(): React.JSX.Element {
  const [settings, setSettings] = useState<OperationsSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedAt, setSavedAt] = useState("");

  const [approvalEnabled, setApprovalEnabled] = useState(false);
  const [approvalUrl, setApprovalUrl] = useState("");
  const [approvalSecret, setApprovalSecret] = useState("");

  const [windowsEnabled, setWindowsEnabled] = useState(false);
  const [windows, setWindows] = useState<MaintenanceWindow[]>([]);

  const [explainerEnabled, setExplainerEnabled] = useState(false);
  const [explainerUrl, setExplainerUrl] = useState("");
  const [explainerApiKey, setExplainerApiKey] = useState("");
  const [explainerModel, setExplainerModel] = useState("");

  useEffect((): void => {
    const loadSettings = async (): Promise<void> => {
      setLoading(true);
      try {
        const response = await fetchApi("/admin/operations-settings") as {
          data?: { attributes?: OperationsSettings };
        };
        const attributes = response.data?.attributes ?? {};
        setSettings(attributes);
        const approval = attributes["approval-webhook"] ?? {};
        setApprovalEnabled(approval.enabled === true);
        setApprovalUrl(approval.url ?? "");
        setApprovalSecret(approval.secret ?? "");
        const windowsGroup = attributes["maintenance-windows"] ?? {};
        setWindowsEnabled(windowsGroup.enabled === true);
        setWindows(windowsGroup.windows ?? []);
        const explainer = attributes["plan-explainer"] ?? {};
        setExplainerEnabled(explainer.enabled === true);
        setExplainerUrl(explainer["endpoint-url"] ?? "");
        setExplainerApiKey(explainer["api-key"] ?? "");
        setExplainerModel(explainer.model ?? "");
      } catch (caught: unknown) {
        setLoadError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    };
    void loadSettings();
  }, []);

  const updateWindow = (index: number, patch: Partial<MaintenanceWindow>): void => {
    setWindows((existing): MaintenanceWindow[] => existing.map((window, i): MaintenanceWindow => (i === index ? { ...window, ...patch } : window)));
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveError("");
    setSavedAt("");
    const attributes: OperationsSettings = {};
    attributes["approval-webhook"] = {
      enabled: approvalEnabled,
      ...(approvalUrl !== "" ? { url: approvalUrl } : { url: null }),
      ...(approvalSecret !== "" ? { secret: approvalSecret } : {}),
    };
    attributes["maintenance-windows"] = {
      enabled: windowsEnabled,
      windows: windows.map((window): MaintenanceWindow => ({
        days: [...window.days].sort(),
        "start-time": window["start-time"],
        "end-time": window["end-time"],
        ...(window.timezone !== undefined && window.timezone !== "" ? { timezone: window.timezone } : {}),
      })),
    };
    attributes["plan-explainer"] = {
      enabled: explainerEnabled,
      ...(explainerUrl !== "" ? { "endpoint-url": explainerUrl } : { "endpoint-url": null }),
      ...(explainerApiKey !== "" ? { "api-key": explainerApiKey } : { "api-key": null }),
      ...(explainerModel !== "" ? { model: explainerModel } : { model: null }),
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

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (loadError !== "") {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <Card>
          <CardContent className="py-8 text-center text-sm text-destructive">{loadError}</CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex items-center gap-3">
        <ShieldAlert className="size-6 text-muted-foreground" aria-hidden="true" />
        <div>
          <h1 className="text-xl font-semibold text-foreground">Operations</h1>
          <p className="text-sm text-muted-foreground">Approval webhook, maintenance windows, and the AI plan explainer.</p>
        </div>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2">
              Approval webhook
              <label className="flex cursor-pointer items-center gap-2 text-sm font-normal text-muted-foreground">
                <input
                  type="checkbox"
                  checked={approvalEnabled}
                  onChange={(event): void => { setApprovalEnabled(event.currentTarget.checked); }}
                  className="size-4 rounded border-gray-300 text-blue-600 focus:ring-blue-600"
                />
                Enabled
              </label>
            </CardTitle>
            <CardDescription>
              External systems can confirm a run by POSTing {"{ run_id, action: \"confirm\" }"} to{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">/api/v2/webhooks/run-approval</code> with an
              HMAC-SHA256 signature in <code className="rounded bg-muted px-1 py-0.5 text-xs">X-Terrence-Signature</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label htmlFor="approval-url" className="mb-1.5 block text-sm font-medium text-foreground">
                Callback URL (optional)
              </label>
              <Input
                id="approval-url"
                value={approvalUrl}
                onInput={(event): void => { setApprovalUrl(event.currentTarget.value); }}
                placeholder="https://example.com/hooks/terrence-approval"
                className="max-w-xl"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                If set, a signed confirmation notification is sent to this URL after a successful approval.
              </p>
            </div>
            <div>
              <label htmlFor="approval-secret" className="mb-1.5 block text-sm font-medium text-foreground">
                Shared secret
              </label>
              <Input
                id="approval-secret"
                value={approvalSecret}
                onInput={(event): void => { setApprovalSecret(event.currentTarget.value); }}
                placeholder="HMAC-SHA256 secret for request signatures"
                className="max-w-xl"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Required to verify incoming approval requests. Leave blank to disable verification.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2">
              Maintenance windows
              <label className="flex cursor-pointer items-center gap-2 text-sm font-normal text-muted-foreground">
                <input
                  type="checkbox"
                  checked={windowsEnabled}
                  onChange={(event): void => { setWindowsEnabled(event.currentTarget.checked); }}
                  className="size-4 rounded border-gray-300 text-blue-600 focus:ring-blue-600"
                />
                Enabled
              </label>
            </CardTitle>
            <CardDescription>
              Applies are blocked during configured windows. Plans are never affected.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {windows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No maintenance windows configured.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {windows.map((window, index): React.JSX.Element => (
                  <div key={index} className="rounded-md border border-gray-200 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {DAY_OPTIONS.map((option): React.JSX.Element => (
                          <button
                            key={option.day}
                            type="button"
                            aria-pressed={window.days.includes(option.day)}
                            aria-label={`Toggle ${option.label}`}
                            onClick={(): void => { updateWindow(index, { days: toggleDay(window.days, option.day) }); }}
                            className={`rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${
                              window.days.includes(option.day)
                                ? "bg-blue-600 text-white"
                                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                            }`}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove maintenance window"
                        onClick={(): void => { setWindows((existing): MaintenanceWindow[] => existing.filter((_, i): boolean => i !== index)); }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <div className="mt-3 flex flex-wrap items-end gap-3">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor={`mw-start-${index}`}>
                          Start
                        </label>
                        <Input
                          id={`mw-start-${index}`}
                          value={window["start-time"]}
                          onInput={(event): void => { updateWindow(index, { "start-time": event.currentTarget.value }); }}
                          placeholder="22:00"
                          className="w-28 font-mono"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor={`mw-end-${index}`}>
                          End
                        </label>
                        <Input
                          id={`mw-end-${index}`}
                          value={window["end-time"]}
                          onInput={(event): void => { updateWindow(index, { "end-time": event.currentTarget.value }); }}
                          placeholder="06:00"
                          className="w-28 font-mono"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor={`mw-tz-${index}`}>
                          Timezone (optional)
                        </label>
                        <Input
                          id={`mw-tz-${index}`}
                          value={window.timezone ?? ""}
                          onInput={(event): void => { updateWindow(index, { timezone: event.currentTarget.value }); }}
                          placeholder="UTC"
                          className="font-mono"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={(): void => { updateWindow(index, { days: [...DAYS_ALL] }); }}
                      >
                        All days
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={(): void => { updateWindow(index, { days: [...DAYS_WEEKDAYS] }); }}
                      >
                        Weekdays
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={(): void => { updateWindow(index, { days: [...DAYS_WEEKEND] }); }}
                      >
                        Weekend
                      </Button>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      Schedule: {humanizeDays(window.days)} · {window["start-time"]}–{window["end-time"]}
                      {window.timezone !== "" ? ` ${window.timezone}` : ""}
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
                  { days: DAYS_WEEKDAYS, "start-time": "22:00", "end-time": "06:00", timezone: "" },
                ]);
              }}
            >
              <Plus className="mr-2 size-4" /> Add window
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2">
              AI plan explainer
              <label className="flex cursor-pointer items-center gap-2 text-sm font-normal text-muted-foreground">
                <input
                  type="checkbox"
                  checked={explainerEnabled}
                  onChange={(event): void => { setExplainerEnabled(event.currentTarget.checked); }}
                  className="size-4 rounded border-gray-300 text-blue-600 focus:ring-blue-600"
                />
                Enabled
              </label>
            </CardTitle>
            <CardDescription>
              Sends a sanitized plan summary to an OpenAI-compatible endpoint to produce a plain-language explanation.
              Never affects run status.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label htmlFor="explainer-url" className="mb-1.5 block text-sm font-medium text-foreground">
                Endpoint URL
              </label>
              <Input
                id="explainer-url"
                value={explainerUrl}
                onInput={(event): void => { setExplainerUrl(event.currentTarget.value); }}
                placeholder="https://api.openai.com/v1/chat/completions"
                className="max-w-xl font-mono"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="explainer-api-key" className="mb-1.5 block text-sm font-medium text-foreground">
                  API key
                </label>
                <Input
                  id="explainer-api-key"
                  type="password"
                  value={explainerApiKey}
                  onInput={(event): void => { setExplainerApiKey(event.currentTarget.value); }}
                  placeholder="Optional bearer token"
                  className="font-mono"
                />
              </div>
              <div>
                <label htmlFor="explainer-model" className="mb-1.5 block text-sm font-medium text-foreground">
                  Model
                </label>
                <Input
                  id="explainer-model"
                  value={explainerModel}
                  onInput={(event): void => { setExplainerModel(event.currentTarget.value); }}
                  placeholder="gpt-4o-mini"
                  className="font-mono"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 flex items-center gap-4">
        <Button type="button" onClick={(): void => { void save(); }} disabled={saving}>
          {saving ? <Spinner className="mr-2 size-4" /> : <Check className="mr-2 size-4" />}
          Save operations settings
        </Button>
        {savedAt !== "" && <span className="text-sm text-muted-foreground">Saved at {savedAt}</span>}
        {saveError !== "" && <span className="text-sm text-destructive">{saveError}</span>}
        {settings !== null && (
          <Badge variant="secondary" className="ml-auto">
            <X className="mr-1 size-3" aria-hidden="true" />
            Read-only fields are hidden; values are stored encrypted where applicable.
          </Badge>
        )}
      </div>
    </div>
  );
}