import { useEffect, useState } from "react";
import { fetchApi, type ReasoningEffort } from "../lib/api";
import { formatDateTime } from "@/lib/utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectItem } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";
import { FuzzyCombobox } from "../components/ui/fuzzy-combobox";
import { Sparkles } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";

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

const CUSTOM_PROVIDER_ID = "custom";

type OperationsSettings = {
  "plan-explainer"?: PlanExplainerSettings;
};

export function AdminPlanExplainer(): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  const [explainerEnabled, setExplainerEnabled] = useState(false);
  const [explainerBaseUrl, setExplainerBaseUrl] = useState("");
  const [explainerApiKey, setExplainerApiKey] = useState("");
  const [explainerApiKeySet, setExplainerApiKeySet] = useState(false);
  const [explainerClearApiKey, setExplainerClearApiKey] = useState(false);
  const [explainerModel, setExplainerModel] = useState("");
  const [explainerProvider, setExplainerProvider] = useState(CUSTOM_PROVIDER_ID);
  const [explainerReasoningEffort, setExplainerReasoningEffort] = useState<ReasoningEffort | "">("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState("");
  const [saveError, setSaveError] = useState("");

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

  const savePlanExplainer = async (): Promise<void> => {
    setSaving(true);
    setSaveError("");
    setSavedAt("");
    try {
      const trimmedBaseUrl = explainerBaseUrl.trim();
      const trimmedModel = explainerModel.trim();
      const trimmedProvider = explainerProvider.trim();
      const payload = {
        enabled: explainerEnabled,
        ...(trimmedBaseUrl !== "" ? { "base-url": trimmedBaseUrl } : { "base-url": null }),
        ...(explainerClearApiKey ? { "api-key": null } : explainerApiKey !== "" ? { "api-key": explainerApiKey } : {}),
        ...(trimmedModel !== "" ? { model: trimmedModel } : { model: null }),
        ...(trimmedProvider !== "" ? { provider: trimmedProvider } : { provider: null }),
        "reasoning-effort": explainerReasoningEffort === "" ? null : explainerReasoningEffort,
      };
      await fetchApi("/admin/operations-settings", {
        method: "PATCH",
        body: JSON.stringify({ data: { attributes: { "plan-explainer": payload } } }),
      });
      setSavedAt(formatDateTime(new Date()));
      setExplainerApiKey("");
      setExplainerClearApiKey(false);
      setExplainerApiKeySet(explainerApiKey !== "" || (explainerApiKeySet && !explainerClearApiKey));
    } catch (caught: unknown) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <PageShell role="status" aria-label="Loading plan explainer settings" variant="form">
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Spinner className="size-6" />
          Loading plan explainer settings…
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
            <Sparkles className="size-7 text-primary" aria-hidden="true" />
            AI plan explainer
          </span>
        )}
        description="Summarize Terraform and OpenTofu execution plans using language models."
      />

      <Card>
        <CardHeader variant="section">
          <CardTitle>Provider and model configuration</CardTitle>
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
            {saveError !== "" && <span className="text-destructive">{saveError}</span>}
            {savedAt !== "" && <span className="text-success">Explainer settings saved at {savedAt}.</span>}
          </span>
          <Button type="button" onClick={(): void => { void savePlanExplainer(); }} disabled={saving}>
            {saving && <Spinner data-icon="inline-start" className="size-4" />}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </CardFooter>
      </Card>
    </PageShell>
  );
}
