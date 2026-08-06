import { useEffect, useRef, useState } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Spinner } from "../components/ui/spinner";
import { UserCog } from "lucide-react";

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
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <UserCog className="mt-0.5 h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">SCIM settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure SCIM provisioning for this installation.
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
                    When enabled, Terrence provisions users and groups through SCIM.
                  </div>
                </div>
                <Checkbox
                  checked={enabled}
                  onCheckedChange={(checked: boolean | "indeterminate"): void => { setEnabled(checked === true); }}
                  aria-label="Enabled"
                />
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <div className="text-sm">
                  <div className="font-medium">Paused</div>
                  <div className="text-muted-foreground">
                    When paused, SCIM provisioning is suspended but remains configured.
                  </div>
                </div>
                <Checkbox
                  checked={paused}
                  onCheckedChange={(checked: boolean | "indeterminate"): void => { setPaused(checked === true); }}
                  aria-label="Paused"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="scim-site-admin-group">
                  Site admin group display name
                </label>
                <Input
                  id="scim-site-admin-group"
                  value={siteAdminGroupDisplayName}
                  readOnly
                  onChange={(e): void => { setSiteAdminGroupDisplayName(e.target.value); }}
                  placeholder="SCIM group that grants site admin access"
                />
                <p className="text-xs text-muted-foreground">Read-only — derived from the site-admin group SCIM id.</p>
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
