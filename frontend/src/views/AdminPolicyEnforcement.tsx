import { useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { ApiError, fetchApi } from "../lib/api";
import { isRecord } from "../lib/type-guards";
import type { LayoutOutletContext } from "../components/Layout";
import { PageHeader, PageShell } from "../components/PageHeader";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Switch } from "../components/ui/switch";
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";

type Settings = Readonly<{ revision: number; opa: boolean; sentinel: boolean }>;
const ENGINES = [
  { key: "opa", label: "OPA" },
  { key: "sentinel", label: "Sentinel" },
] as const;

function parseSettings(response: unknown): Settings {
  const attributes = isRecord(response) && isRecord(response["data"]) ? response["data"]["attributes"] : null;
  if (
    !isRecord(attributes) ||
    typeof attributes["revision"] !== "number" ||
    !Number.isSafeInteger(attributes["revision"]) ||
    attributes["revision"] < 0 ||
    (attributes["opa"] !== undefined && typeof attributes["opa"] !== "boolean") ||
    (attributes["sentinel"] !== undefined && typeof attributes["sentinel"] !== "boolean")
  ) {
    throw new Error("Could not read policy enforcement settings. Reload before making changes.");
  }
  return {
    revision: attributes["revision"],
    opa: attributes["opa"] !== false,
    sentinel: attributes["sentinel"] !== false,
  };
}

export function AdminPolicyEnforcement(): React.JSX.Element {
  const context = useOutletContext<LayoutOutletContext | undefined>();
  if (context?.accountLoaded !== true) return <PageShell role="status">Loading account…</PageShell>;
  if (!context.siteAdmin)
    return (
      <PageShell>
        <p role="alert">Site-administrator access is required.</p>
      </PageShell>
    );
  return <PolicyEnforcementSettings />;
}

function hasChanges(settings: Settings | null, draft: Readonly<{ opa: boolean; sentinel: boolean }>): boolean {
  return settings !== null && (draft.opa !== settings.opa || draft.sentinel !== settings.sentinel);
}

function PolicyEnforcementSettings(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState({ opa: true, sentinel: true });
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const saveLock = useRef(false);

  useEffect((): (() => void) => {
    let current = true;
    setLoading(true);
    setLoadError("");
    void fetchApi("/admin/policy-enforcement")
      .then((response): void => {
        if (!current) return;
        const latest = parseSettings(response);
        setSettings(latest);
        setDraft({ opa: latest.opa, sentinel: latest.sentinel });
        setConflict(false);
        setSaveError("");
        setSaved(false);
        setReason("");
      })
      .catch((error: unknown): void => {
        if (current) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally((): void => {
        if (current) setLoading(false);
      });
    return (): void => {
      current = false;
    };
  }, [attempt]);

  const trimmedReason = reason.trim();
  const reasonValid = trimmedReason.length > 0 && trimmedReason.length <= 2000;
  const changed = hasChanges(settings, draft);
  const controlsDisabled = loading || saving || conflict || settings === null;
  const save = async (): Promise<void> => {
    if (saveLock.current || controlsDisabled || !reasonValid || !changed) return;
    saveLock.current = true;
    setSaving(true);
    setSaved(false);
    setSaveError("");
    try {
      const latest = parseSettings(
        await fetchApi("/admin/policy-enforcement", {
          method: "PATCH",
          body: JSON.stringify({
            data: {
              type: "policy-enforcement",
              attributes: {
                revision: settings.revision,
                reason: trimmedReason,
                ...(draft.opa !== settings.opa ? { opa: draft.opa } : {}),
                ...(draft.sentinel !== settings.sentinel ? { sentinel: draft.sentinel } : {}),
              },
            },
          }),
        }),
      );
      setSettings(latest);
      setDraft({ opa: latest.opa, sentinel: latest.sentinel });
      setReason("");
      setSaved(true);
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
        setSaveError(
          "Settings changed since you loaded them. Reload the latest settings, then review and reapply your changes. Your changes have not been saved.",
        );
      } else setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  };

  if (loading)
    return (
      <PageShell role="status" variant="form">
        <Spinner /> Loading policy enforcement…
      </PageShell>
    );
  if (loadError !== "")
    return (
      <PageShell variant="form">
        <p role="alert">{loadError}</p>
        <Button
          onClick={(): void => {
            setAttempt(attempt + 1);
          }}
        >
          Reload settings
        </Button>
      </PageShell>
    );

  return (
    <PageShell variant="form">
      <PageHeader
        eyebrow="Site administration"
        title="Policy enforcement"
        description="Control site-wide OPA and Sentinel enforcement independently."
      />
      <Card>
        <CardHeader variant="section">
          <CardTitle>Policy engine enforcement</CardTitle>
          <CardDescription>
            Both engines enforce policies by default. While enabled, evaluation errors block runs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Disabling an engine is an intentional, audited site-wide bypass, not policy advisory mode. Changes apply at
            subsequent policy gates without restart. Changing settings after policy evaluation requires a new plan
            before apply; completed applies are not reversed.
          </p>
          {ENGINES.map(
            ({ key, label }): React.JSX.Element => (
              <div key={key} className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
                <div>
                  <label htmlFor={`enforcement-${key}`} className="text-sm font-medium">
                    {label} enforcement
                  </label>
                  <p className="text-sm">
                    Current: {settings?.[key] === false ? "Disabled · site-wide bypass" : "Active · enforcing policies"}
                  </p>
                  {settings !== null && draft[key] !== settings[key] && (
                    <p className="text-sm text-warning">
                      Unsaved: {draft[key] ? "Enable enforcement" : "Disable enforcement · site-wide bypass"}
                    </p>
                  )}
                </div>
                <Switch
                  id={`enforcement-${key}`}
                  aria-label={`${label} enforcement`}
                  checked={draft[key]}
                  disabled={controlsDisabled}
                  onCheckedChange={(value): void => {
                    setDraft({ ...draft, [key]: value });
                    setSaved(false);
                  }}
                />
              </div>
            ),
          )}
          <div className="space-y-1.5">
            <label htmlFor="enforcement-reason" className="block text-sm font-medium">
              Reason for change (required)
            </label>
            <Textarea
              id="enforcement-reason"
              value={reason}
              disabled={controlsDisabled}
              rows={3}
              aria-describedby="enforcement-reason-help"
              onInput={(event): void => {
                setReason(event.currentTarget.value);
              }}
            />
            <p id="enforcement-reason-help" className="text-xs text-muted-foreground">
              Enter 1–2000 characters after trimming whitespace. The reason is recorded in the audit log.
            </p>
            {trimmedReason.length > 2000 && <p role="alert">Reason must be at most 2000 characters.</p>}
          </div>
          {saveError !== "" && (
            <p role="alert" className="text-destructive">
              {saveError}
            </p>
          )}
          {conflict && (
            <Button
              variant="outline"
              onClick={(): void => {
                setAttempt(attempt + 1);
              }}
            >
              Reload latest settings
            </Button>
          )}
          {saved && (
            <p role="status" className="text-success">
              Policy enforcement saved and audited. Revision {settings?.revision}.
            </p>
          )}
        </CardContent>
        <CardFooter className="justify-end">
          <Button
            disabled={controlsDisabled || !reasonValid || !changed}
            onClick={(): void => {
              void save();
            }}
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </CardFooter>
      </Card>
    </PageShell>
  );
}
