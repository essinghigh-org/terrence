import { useEffect, useRef, useState } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Spinner } from "../components/ui/spinner";
import { UserCog } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";

type ScimSettingsAttributes = {
  enabled?: boolean;
  paused?: boolean;
  "site-admin-group-scim-id"?: string | null;
  "site-admin-group-display-name"?: string | null;
};

export function AdminScimSettings(): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [enabled, setEnabled] = useState(false);
  const [previouslyEnabled, setPreviouslyEnabled] = useState(false);
  const [paused, setPaused] = useState(false);
  const [siteAdminGroupScimId, setSiteAdminGroupScimId] = useState<string | null>(null);
  const [siteAdminGroupDisplayName, setSiteAdminGroupDisplayName] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);

  const mounted = useRef(true);

  const load = async (): Promise<void> => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetchApi("/admin/scim-settings") as {
        data?: { attributes?: ScimSettingsAttributes };
      };
      if (!mounted.current) return;
      const attrs = response.data?.attributes;
      setEnabled(attrs?.enabled === true);
      setPreviouslyEnabled(attrs?.enabled === true);
      setPaused(attrs?.paused === true);
      setSiteAdminGroupScimId(attrs?.["site-admin-group-scim-id"] ?? null);
      setSiteAdminGroupDisplayName(
        typeof attrs?.["site-admin-group-display-name"] === "string"
          ? attrs["site-admin-group-display-name"]
          : "",
      );
    } catch (reason) {
      if (mounted.current) {
        setLoadError(reason instanceof Error ? reason.message : "Failed to load SCIM settings.");
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
      // Disabling SCIM goes through DELETE — the backend rejects enabled:false
      // ("Use DELETE to disable SCIM"). Handle it explicitly instead of
      // silently dropping the user's intent.
      if (!enabled && previouslyEnabled) {
        await fetchApi("/admin/scim-settings", { method: "DELETE" });
        setSaved(true);
        await load();
        return;
      }
      const attributes: Record<string, unknown> = {
        paused,
        // site-admin-group-display-name is read-only (derived from the SCIM
        // id, which has no write path) — do not submit it.
      };
      // The backend rejects enabled: false, so only send enabled when turning
      // it on; omitting it keeps the current value.
      if (enabled) {
        attributes["enabled"] = true;
      }
      if (siteAdminGroupScimId !== null && siteAdminGroupScimId !== "") {
        attributes["site-admin-group-scim-id"] = siteAdminGroupScimId;
      }
      await fetchApi("/admin/scim-settings", {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            type: "scim-settings",
            attributes,
          },
        }),
      });
      setSaved(true);
      await load();
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "Failed to save SCIM settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageShell className="max-w-5xl">
      <PageHeader
        eyebrow="Site administration"
        title={<span className="flex items-center gap-2"><UserCog className="size-7 text-primary" aria-hidden="true" />SCIM settings</span>}
        description="Configure automated user and group provisioning for this installation."
      />

      <Card>
        <CardHeader variant="section">
          <CardTitle>SCIM connection</CardTitle>
          <CardDescription>Provision users and groups from your identity provider while keeping the connection state visible here.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Spinner />
              Loading SCIM settings…
            </div>
          ) : loadError !== "" ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              <span>{loadError}</span>
              <Button type="button" size="sm" variant="outline" onClick={(): void => { void load(); }} disabled={loading}>Try again</Button>
            </div>
          ) : (
            <form onSubmit={(event): void => { event.preventDefault(); void save(); }} className="space-y-4">
              <label htmlFor="scim-enabled" className="flex cursor-pointer items-center justify-between rounded-md border p-3 transition-colors hover:bg-muted/40">
                <div className="text-sm">
                  <div className="font-medium">Enabled</div>
                  <div className="text-muted-foreground">
                    When enabled, Terrence provisions users and groups through SCIM.
                  </div>
                </div>
                <Checkbox
                  id="scim-enabled"
                  checked={enabled}
                  onCheckedChange={(checked: boolean | "indeterminate"): void => { setEnabled(checked === true); }}
                  aria-label="Enabled"
                />
              </label>

              <label htmlFor="scim-paused" className="flex cursor-pointer items-center justify-between rounded-md border p-3 transition-colors hover:bg-muted/40">
                <div className="text-sm">
                  <div className="font-medium">Paused</div>
                  <div className="text-muted-foreground">
                    When paused, SCIM provisioning is suspended but remains configured.
                  </div>
                </div>
                <Checkbox
                  id="scim-paused"
                  checked={paused}
                  onCheckedChange={(checked: boolean | "indeterminate"): void => { setPaused(checked === true); }}
                  aria-label="Paused"
                />
              </label>

              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="scim-site-admin-group">
                  Site admin group display name
                </label>
                <Input
                  id="scim-site-admin-group"
                  name="site-admin-group-display-name"
                  value={siteAdminGroupDisplayName}
                  readOnly
                  placeholder="SCIM group that grants site admin access"
                />
                <p className="text-xs text-muted-foreground">Read-only — derived from the site-admin group SCIM id.</p>
              </div>

              {saveError !== "" && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{saveError}</div>}
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
