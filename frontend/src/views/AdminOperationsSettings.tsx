import { useEffect, useState } from "react";
import { fetchApi, type ReasoningEffort } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardAction, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";
import { Badge } from "../components/ui/badge";
import { Checkbox } from "../components/ui/checkbox";
import { FuzzyCombobox } from "../components/ui/fuzzy-combobox";
import { Check, LockKeyhole, Plus, ShieldAlert, Trash2 } from "lucide-react";
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
const DAY_OPTIONS = DAY_LABELS.map((label, index) => ({ day: index, label }));

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

function SettingToggle({
  id,
  label,
  checked,
  onCheckedChange,
}: Readonly<{
  id: string;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}>): React.JSX.Element {
  return (
    <label
      htmlFor={id}
      className={`inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-medium shadow-sm transition-colors hover:bg-muted ${
        checked ? "border-success/30 bg-success/5 text-success" : "border-border bg-background text-muted-foreground"
      }`}
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={`${checked ? "Disable" : "Enable"} ${label}`}
      />
      <span>{checked ? "Enabled" : "Disabled"}</span>
    </label>
  );
}

export function AdminOperationsSettings(): React.JSX.Element {
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

  const [windowsEnabled, setWindowsEnabled] = useState(false);
  const [windows, setWindows] = useState<MaintenanceWindow[]>([]);

  const [explainerEnabled, setExplainerEnabled] = useState(false);
  const [explainerBaseUrl, setExplainerBaseUrl] = useState("");
  const [explainerApiKey, setExplainerApiKey] = useState("");
  const [explainerApiKeySet, setExplainerApiKeySet] = useState(false);
  const [explainerClearApiKey, setExplainerClearApiKey] = useState(false);
  const [explainerModel, setExplainerModel] = useState("");
  const [explainerProvider, setExplainerProvider] = useState(CUSTOM_PROVIDER_ID);
  const [explainerReasoningEffort, setExplainerReasoningEffort] = useState<ReasoningEffort | "">("");

  // Provider/model catalog for the explainer pickers (models.dev via admin API).
  const [providers, setProviders] = useState<ExplainerProvider[]>([]);
  const [providerModels, setProviderModels] = useState<ExplainerModel[]>([]);
  const [providerCatalogError, setProviderCatalogError] = useState("");

  useEffect((): void => {
    const loadSettings = async (): Promise<void> => {
      setLoading(true);
      setLoadError("");
      try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
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

  // Provider catalog for the explainer pickers, fetched in the background.
  // The backend refreshes from models.dev with a 6h TTL; the picker is a
  // convenience and never blocks saving. Failures degrade to free-text entry.
  useEffect((): void => {
    const loadCatalog = async (): Promise<void> => {
      try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
        const response = await fetchApi("/admin/operations-settings/explainer/providers") as {
          data?: { id: string; attributes?: { name?: string; "model-count"?: number } }[];
        };
        const rows = response.data ?? [];
        setProviders(rows.map((row): ExplainerProvider => ({
          id: row.id,
          name: row.attributes?.name ?? row.id,
          "model-count": row.attributes?.["model-count"] ?? 0,
        })));
      } catch (caught: unknown) {
        setProviderCatalogError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void loadCatalog();
  }, []);

  // When the stored provider resolves to a catalog entry, load its models so
  // the picker shows suggestions (the raw value stays editable either way).
  useEffect((): (() => void) => {
    if (explainerProvider === "") {
      setProviderModels([]);
      return (): void => undefined;
    }
    let cancelled = false;
    const loadModels = async (): Promise<void> => {
      try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
        const response = await fetchApi(`/admin/operations-settings/explainer/models?provider=${encodeURIComponent(explainerProvider)}`) as {
          data?: { id: string; attributes?: { name?: string; reasoning?: boolean; context?: number | null } }[];
        };
        if (cancelled) return;
        setProviderModels((response.data ?? []).map((row): ExplainerModel => ({
          id: row.id,
          name: row.attributes?.name ?? row.id,
          reasoning: row.attributes?.reasoning === true,
          context: row.attributes?.context ?? null,
        })));
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

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveError("");
    setSavedAt("");
    const attributes: OperationsSettings = {};
    attributes["approval-webhook"] = {
      enabled: approvalEnabled,
      ...(approvalUrl !== "" ? { url: approvalUrl } : { url: null }),
      // secret omitted -> preserve the stored value; null -> clear it;
      // non-empty -> replace it. The read surface only reports *-set.
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
      ...(explainerBaseUrl !== "" ? { "base-url": explainerBaseUrl } : { "base-url": null }),
      ...(explainerClearApiKey ? { "api-key": null } : explainerApiKey !== "" ? { "api-key": explainerApiKey } : {}),
      ...(explainerModel !== "" ? { model: explainerModel } : { model: null }),
      ...(explainerProvider !== "" ? { provider: explainerProvider } : { provider: null }),
      "reasoning-effort": explainerReasoningEffort === "" ? null : explainerReasoningEffort,
    };
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
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
      <PageShell role="status" aria-label="Loading operations settings" className="max-w-5xl">
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Spinner className="size-6" />
          Loading operations settings…
        </div>
      </PageShell>
    );
  }

  if (loadError !== "") {
    return (
      <PageShell className="max-w-5xl">
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
    <PageShell className="max-w-5xl">
      <PageHeader
        eyebrow="Site administration"
        title={(
          <span className="flex items-center gap-2">
            <ShieldAlert className="size-7 text-primary" aria-hidden="true" />
            Operations
          </span>
        )}
        description="Control approvals, maintenance windows, and plain-language plan explanations."
      />

      <div className="space-y-5">
        <Card>
          <CardHeader variant="section">
            <CardTitle>Approval webhook</CardTitle>
            <CardDescription>
              External systems can confirm a run by POSTing {"{ run_id, action: \"confirm\" }"} to{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">/api/v2/webhooks/run-approval</code> with an
              HMAC-SHA256 signature in <code className="rounded bg-muted px-1 py-0.5 text-xs">X-Terrence-Signature</code>.
            </CardDescription>
            <CardAction>
              <SettingToggle id="approval-enabled" label="approval webhook" checked={approvalEnabled} onCheckedChange={setApprovalEnabled} />
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label htmlFor="approval-url" className="mb-1.5 block text-sm font-medium text-foreground">
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
              <p className="mt-1 text-xs text-muted-foreground">
                If set, a signed confirmation notification is sent to this URL after a successful approval.
              </p>
            </div>
            <div>
              <label htmlFor="approval-secret" className="mb-1.5 block text-sm font-medium text-foreground">
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
              <p className="mt-1 text-xs text-muted-foreground">
                Required to verify incoming approval requests. Leave blank to keep the stored secret.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader variant="section">
            <CardTitle>Maintenance windows</CardTitle>
            <CardDescription>
              Applies are blocked during configured windows. Plans are never affected.
            </CardDescription>
            <CardAction>
              <SettingToggle id="maintenance-enabled" label="maintenance windows" checked={windowsEnabled} onCheckedChange={setWindowsEnabled} />
            </CardAction>
          </CardHeader>
          <CardContent>
            {windows.length === 0 ? (
              <div className="rounded-lg border border-dashed bg-muted/30 px-4 py-8 text-center">
                <p className="text-sm font-medium text-foreground">No maintenance windows yet</p>
                <p className="mt-1 text-sm text-muted-foreground">Add a window when applies need a predictable pause.</p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {windows.map((window, index): React.JSX.Element => (
                  <div key={index} className="rounded-md border border-border p-4">
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
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted text-muted-foreground hover:bg-muted/80"
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
                          name={`maintenance-${index}-start`}
                          type="time"
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
                          name={`maintenance-${index}-end`}
                          type="time"
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
                          name={`maintenance-${index}-timezone`}
                          autoComplete="off"
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
                      {window.timezone !== undefined && window.timezone !== "" ? ` ${window.timezone}` : ""}
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

        <Card className="overflow-visible">
          <CardHeader variant="section">
            <CardTitle>AI plan explainer</CardTitle>
            <CardDescription>
              Sends a sanitized plan summary to the selected provider for a plain-language explanation.
              Never affects run status.
            </CardDescription>
            <CardAction>
              <SettingToggle id="explainer-enabled" label="AI plan explainer" checked={explainerEnabled} onCheckedChange={setExplainerEnabled} />
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
              <div>
                <label htmlFor="explainer-provider" className="mb-1.5 block text-sm font-medium text-foreground">
                  Provider
                </label>
                <FuzzyCombobox
                  id="explainer-provider"
                  name="provider"
                  value={explainerProvider}
                  options={providers.map((provider) => ({
                    id: provider.id,
                    label: provider.name,
                    hint: provider.id === CUSTOM_PROVIDER_ID
                      ? "any OpenAI-compatible endpoint"
                      : `${provider["model-count"]} models`,
                  }))}
                  onSelect={(providerId: string): void => {
                    setExplainerProvider(providerId);
                  }}
                  placeholder="e.g. openrouter…"
                  emptyText="No providers (catalog unavailable)"
                  aria-describedby="explainer-provider-help"
                  inputClassName="h-9 bg-background"
                />
                <p id="explainer-provider-help" className="mt-1 text-xs text-muted-foreground">
                  From the models.dev catalog (refreshed every 6h). Selecting a provider loads its model suggestions.
                </p>
              </div>
              <div>
                <label htmlFor="explainer-model" className="mb-1.5 block text-sm font-medium text-foreground">
                  Model
                </label>
                <FuzzyCombobox
                  id="explainer-model"
                  name="model"
                  value={explainerModel}
                  options={providerModels.map((model) => ({
                    id: model.id,
                    label: model.name,
                    hint: `${model.reasoning ? "reasoning · " : ""}${model.context !== null ? `${Math.round(model.context / 1000)}k ctx` : ""}`.replace(/^ · | $/g, ""),
                  }))}
                  onSelect={setExplainerModel}
                  placeholder="e.g. gpt-4o-mini…"
                  emptyText={explainerProvider === CUSTOM_PROVIDER_ID
                    ? "Type a model id (no catalog for custom providers)"
                    : "No models for this provider"}
                  inputClassName="h-9 bg-background font-mono"
                />
              </div>
              <div>
                <label htmlFor="explainer-reasoning-effort" className="mb-1.5 block text-sm font-medium text-foreground">
                  Reasoning effort
                </label>
                <FuzzyCombobox
                  id="explainer-reasoning-effort"
                  name="reasoning-effort"
                  value={explainerReasoningEffort}
                  options={[
                    { id: "", label: "Automatic (model default)" },
                    { id: "none", label: "None" },
                    { id: "minimal", label: "Minimal" },
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium" },
                    { id: "high", label: "High" },
                    { id: "xhigh", label: "XHigh" },
                    { id: "max", label: "Max" },
                  ]}
                  onSelect={(value: string): void => {

                    // SAFETY: the change event carries one of the union values the UI renders from the same options.

                    setExplainerReasoningEffort(value as ReasoningEffort | "");

                  }}
                  allowCustom={false}
                  inputClassName="h-9 bg-background"
                  aria-describedby="explainer-reasoning-effort-help"
                />
                <p id="explainer-reasoning-effort-help" className="mt-1 text-xs text-muted-foreground">
                  Optional. Automatic leaves the provider’s model default unchanged.
                </p>
              </div>
              <div>
                <label htmlFor="explainer-base-url" className="mb-1.5 block text-sm font-medium text-foreground">
                  Base URL (optional)
                </label>
                <Input
                  id="explainer-base-url"
                  name="explainer-base-url"
                  type="url"
                  autoComplete="url"
                  spellCheck={false}
                  value={explainerBaseUrl}
                  onInput={(event): void => { setExplainerBaseUrl(event.currentTarget.value); }}
                  placeholder="e.g. https://api.example.com/v1…"
                  className="rounded-lg bg-background font-mono"
                  aria-describedby="explainer-base-url-help"
                />
                <p id="explainer-base-url-help" className="mt-1 text-xs text-muted-foreground">
                  {explainerProvider === CUSTOM_PROVIDER_ID
                    ? "Required for the custom provider. The chat completions path is added automatically."
                    : "Leave blank to use the selected provider’s models.dev URL. The chat completions path is added automatically."}
                </p>
              </div>
            </div>
            <div className="max-w-2xl">
              <label htmlFor="explainer-api-key" className="mb-1.5 block text-sm font-medium text-foreground">
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
                  className="flex-1 rounded-lg bg-background font-mono"
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
        </Card>
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