import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import { useUnsavedChangesWarning } from "../lib/use-unsaved-changes";
import { PageHeader, PageShell, SettingsSection } from "../components/PageHeader";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { SiteBanner, PRESENTATION_CHANGED_EVENT, type Announcement } from "../components/SitePresentation";

type Customization = Record<string, string | null | { source: string; enabled: boolean }[]>;
const fields = [
  ["support-email-address", "Support email", "email"],
  ["support-url-address", "Public support URL", "url"],
  ["internal-support-url", "Internal support URL", "url"],
  ["internal-documentation-url", "Internal documentation URL", "url"],
  ["internal-tutorials-url", "Internal tutorials URL", "url"],
  ["login-help", "Sign-in help", "text"],
  ["new-user", "New account help", "text"],
  ["error", "Error help", "text"],
  ["footer", "Footer", "text"],
] as const;
const emptyBanner: Announcement = {
  id: "",
  attributes: {
    title: "",
    body: "",
    style: "info",
    audience: "authenticated_only",
    "scheduled-publish-at": null,
    "scheduled-expire-at": null,
    timezone: null,
  },
};
const changed = (): void => {
  window.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
};
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const datetimeValue = (value: string | null): string =>
  value === null ? "" : new Date(value).toISOString().slice(0, 16);

function BannerEditor({
  initial,
  onSaved,
}: Readonly<{ initial: Announcement | null; onSaved: (value: Announcement | null) => void }>): React.JSX.Element {
  const [draft, setDraft] = useState<Announcement>(initial ?? emptyBanner);
  const [scheduled, setScheduled] = useState(initial?.attributes["scheduled-publish-at"] != null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [deactivate, setDeactivate] = useState(false);
  useUnsavedChangesWarning(JSON.stringify(draft) !== JSON.stringify(initial ?? emptyBanner));
  const update = (key: keyof Announcement["attributes"], value: string | null): void => {
    setSuccess("");
    setDraft((current): Announcement => ({ ...current, attributes: { ...current.attributes, [key]: value } }));
  };
  const save = async (): Promise<void> => {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const attributes = draft.attributes;
      if (
        scheduled &&
        [attributes["scheduled-publish-at"], attributes["scheduled-expire-at"], attributes.timezone].some(
          (value): boolean => value === null || value === "",
        )
      )
        throw new Error("Set publication, expiry and timezone before saving.");
      const result = await fetchApi<{ data: Announcement }>(
        initial === null ? "/admin/banners" : `/admin/banners/${initial.id}`,
        {
          method: initial === null ? "POST" : "PATCH",
          body: JSON.stringify({
            data: {
              type: "admin-banners",
              attributes: {
                title: attributes.title,
                body: attributes.body,
                style: attributes.style,
                audience: attributes.audience,
                "scheduled-publish-at": scheduled ? attributes["scheduled-publish-at"] : null,
                "scheduled-expire-at": scheduled ? attributes["scheduled-expire-at"] : null,
                timezone: scheduled ? attributes.timezone : null,
              },
            },
          }),
        },
      );
      setDraft(result.data);
      onSaved(result.data);
      changed();
      setSuccess("Announcement saved.");
    } catch (caught: unknown) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (): Promise<void> => {
    if (initial === null) return;
    setBusy(true);
    setError("");
    try {
      await fetchApi(`/admin/banners/${initial.id}`, { method: "DELETE" });
      setDraft(emptyBanner);
      setScheduled(false);
      onSaved(null);
      changed();
      setSuccess("Announcement deactivated.");
    } catch (caught: unknown) {
      setError(message(caught));
    } finally {
      setBusy(false);
      setDeactivate(false);
    }
  };
  return (
    <SettingsSection
      title="Site announcement"
      description="One announcement at a time. Scheduled times below are UTC; the timezone is retained for provider compatibility."
    >
      <form
        className="space-y-4"
        onSubmit={(event): void => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="block space-y-1">
          Title
          <Input
            id="banner-title"
            value={draft.attributes.title}
            maxLength={100}
            required
            disabled={busy}
            onInput={(event): void => {
              update("title", event.currentTarget.value);
            }}
          />
        </label>
        <label className="block space-y-1">
          Body
          <textarea
            id="banner-body"
            className="min-h-24 w-full rounded-md border bg-background p-2"
            value={draft.attributes.body}
            required
            disabled={busy}
            onInput={(event): void => {
              update("body", event.currentTarget.value);
            }}
            aria-describedby="banner-body-help"
          />
        </label>
        <p id="banner-body-help" className="text-sm text-muted-foreground">
          Up to 500 characters after sanitization. Supports strong, em and HTTP/HTTPS links; other HTML is removed.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1">
            Style
            <select
              className="w-full rounded-md border bg-background p-2"
              value={draft.attributes.style}
              disabled={busy}
              onChange={(event): void => {
                update("style", event.currentTarget.value);
              }}
            >
              <option value="info">Information</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <label className="block space-y-1">
            Audience
            <select
              className="w-full rounded-md border bg-background p-2"
              value={draft.attributes.audience}
              disabled={busy}
              onChange={(event): void => {
                update("audience", event.currentTarget.value);
              }}
            >
              <option value="authenticated_only">Signed-in users</option>
              <option value="all_users">Everyone, including sign-in pages</option>
            </select>
          </label>
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={scheduled}
            disabled={busy}
            onChange={(event): void => {
              setScheduled(event.target.checked);
              update("timezone", event.target.checked ? "UTC" : null);
              if (!event.target.checked) {
                update("scheduled-publish-at", null);
                update("scheduled-expire-at", null);
              }
            }}
          />
          Schedule publication and expiry
        </label>
        {scheduled && (
          <div className="grid gap-4 sm:grid-cols-3">
            <label>
              Publish at (UTC)
              <Input
                type="datetime-local"
                required
                disabled={busy}
                value={datetimeValue(draft.attributes["scheduled-publish-at"])}
                onInput={(event): void => {
                  update(
                    "scheduled-publish-at",
                    event.currentTarget.value === "" ? null : new Date(`${event.currentTarget.value}Z`).toISOString(),
                  );
                }}
              />
            </label>
            <label>
              Expire at (UTC)
              <Input
                type="datetime-local"
                required
                disabled={busy}
                value={datetimeValue(draft.attributes["scheduled-expire-at"])}
                onInput={(event): void => {
                  update(
                    "scheduled-expire-at",
                    event.currentTarget.value === "" ? null : new Date(`${event.currentTarget.value}Z`).toISOString(),
                  );
                }}
              />
            </label>
            <label>
              Timezone (IANA)
              <Input
                required
                disabled={busy}
                value={draft.attributes.timezone ?? ""}
                onInput={(event): void => {
                  update("timezone", event.currentTarget.value);
                }}
                placeholder="Europe/London"
              />
            </label>
          </div>
        )}
        <div>
          <p className="mb-2 text-sm font-medium">Preview</p>
          <SiteBanner preview={draft} />
        </div>
        {error !== "" && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {success !== "" && <p role="status">{success}</p>}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save announcement"}
          </Button>
          {initial !== null && (
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={(): void => {
                setDeactivate(true);
              }}
            >
              Deactivate
            </Button>
          )}
        </div>
      </form>
      <ConfirmDialog
        open={deactivate}
        onOpenChange={setDeactivate}
        title="Deactivate announcement?"
        description="This removes the announcement for all users. You can create a new one afterwards."
        loading={busy}
        confirmText="Deactivate"
        onConfirm={(): void => {
          void remove();
        }}
      />
    </SettingsSection>
  );
}

function CustomizationEditor({ initial }: Readonly<{ initial: Customization }>): React.JSX.Element {
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  useUnsavedChangesWarning(JSON.stringify(saved) !== JSON.stringify(draft));
  const sources = draft["avatar-sources"];
  const gravatar =
    Array.isArray(sources) && sources.some((source): boolean => source.source === "gravatar" && source.enabled);
  const save = async (): Promise<void> => {
    setBusy(true);
    setError("");
    setSuccess(false);
    try {
      const result = await fetchApi<{ data: { attributes: Customization } }>("/admin/customization-settings", {
        method: "PATCH",
        body: JSON.stringify({ data: { type: "customization-settings", attributes: draft } }),
      });
      setDraft(result.data.attributes);
      setSaved(result.data.attributes);
      setSuccess(true);
      changed();
    } catch (caught: unknown) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection
      title="Help and customization"
      description="Public help, footer and error text are visible before sign-in. Internal links are only shown to signed-in users. Text is rendered as plain text."
    >
      <form
        className="space-y-4"
        onSubmit={(event): void => {
          event.preventDefault();
          void save();
        }}
      >
        {fields.map(
          ([key, label, type]): React.JSX.Element => (
            <label key={key} className="block space-y-1">
              {label}
              {type === "text" ? (
                <textarea
                  id={`customization-${key}`}
                  className="min-h-20 w-full rounded-md border bg-background p-2"
                  value={typeof draft[key] === "string" ? draft[key] : ""}
                  disabled={busy}
                  onInput={(event): void => {
                    setSuccess(false);
                    setDraft({ ...draft, [key]: event.currentTarget.value });
                  }}
                />
              ) : (
                <Input
                  id={`customization-${key}`}
                  type={key === "support-url-address" ? "text" : type}
                  value={typeof draft[key] === "string" ? draft[key] : ""}
                  disabled={busy}
                  onInput={(event): void => {
                    setSuccess(false);
                    setDraft({ ...draft, [key]: event.currentTarget.value });
                  }}
                />
              )}
            </label>
          ),
        )}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={gravatar}
            disabled={busy}
            onChange={(event): void => {
              setSuccess(false);
              setDraft({ ...draft, "avatar-sources": [{ source: "gravatar", enabled: event.target.checked }] });
            }}
          />
          Enable Gravatar user avatars
        </label>
        <p className="text-sm text-muted-foreground">
          Avatars are fetched through the server. Disabling Gravatar uses initials and stops new Gravatar fetches; VCS
          and provider icons are unaffected.
        </p>
        {error !== "" && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {success && <p role="status">Customization saved.</p>}
        <Button disabled={busy} type="submit">
          {busy ? "Saving…" : "Save customization"}
        </Button>
      </form>
    </SettingsSection>
  );
}

export function AdminAppearance(): React.JSX.Element {
  const [customization, setCustomization] = useState<Customization | null>(null);
  const [banner, setBanner] = useState<Announcement | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    const load = async (): Promise<void> => {
      try {
        const [settings, banners] = await Promise.all([
          fetchApi<{ data: { attributes: Customization } }>("/admin/customization-settings"),
          fetchApi<{ data: Announcement[] }>("/admin/banners"),
        ]);
        if (active) {
          setCustomization(settings.data.attributes);
          setBanner(banners.data[0] ?? null);
        }
      } catch (caught: unknown) {
        if (active) setError(message(caught));
      }
    };
    void load();
    return (): void => {
      active = false;
    };
  }, [attempt]);
  return (
    <PageShell variant="form">
      <PageHeader title="Appearance" description="Announcements and instance-wide help." />
      {error !== "" ? (
        <div role="alert">
          <p>{error}</p>
          <Button
            onClick={(): void => {
              setAttempt(attempt + 1);
            }}
          >
            Retry
          </Button>
        </div>
      ) : customization === null ? (
        <p role="status">Loading appearance settings…</p>
      ) : (
        <>
          <BannerEditor initial={banner} onSaved={setBanner} />
          <CustomizationEditor initial={customization} />
        </>
      )}
    </PageShell>
  );
}
