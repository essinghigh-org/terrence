import { useEffect, useState } from "react";
import { fetchApi } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../../components/ui/dialog";

type Architecture = { os: string; arch: string; url: string; sha: string };
type VersionAttributes = {
  version: string;
  official: boolean;
  enabled: boolean;
  beta: boolean;
  deprecated: boolean;
  "deprecated-reason": string | null;
  archs: Architecture[];
};
type Version = { id: string; attributes: VersionAttributes };
const emptyArchitecture = (): Architecture => ({ os: "linux", arch: "amd64", url: "", sha: "" });
const emptyVersion = (): VersionAttributes => ({
  version: "",
  official: false,
  enabled: true,
  beta: false,
  deprecated: false,
  "deprecated-reason": null,
  archs: [emptyArchitecture()],
});

export function validateTfpolicyVersion(value: VersionAttributes): string | null {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) return "Enter a semantic version, such as 0.2.0.";
  if (value.deprecated && (value["deprecated-reason"] ?? "").trim() === "") return "Provide a deprecation reason.";
  if (value.archs.length === 0) return "Add at least one architecture.";
  const seen = new Set<string>();
  for (const entry of value.archs) {
    if (entry.os !== "linux" || !["amd64", "arm64", "s390x"].includes(entry.arch))
      return "Choose a supported Linux architecture.";
    if (seen.has(entry.arch)) return "Each architecture must be unique.";
    seen.add(entry.arch);
    if (!/^[a-f0-9]{64}$/.test(entry.sha)) return "Each binary needs a lowercase SHA-256 checksum (64 characters).";
    try {
      if (!["http:", "https:"].includes(new URL(entry.url).protocol)) return "Binary URLs must use HTTP or HTTPS.";
    } catch {
      return "Enter a valid binary URL.";
    }
  }
  return null;
}

function VersionEditor({
  value,
  setValue,
}: Readonly<{ value: VersionAttributes; setValue: (value: VersionAttributes) => void }>): React.JSX.Element {
  const changeArch = (index: number, field: keyof Architecture, text: string): void => {
    setValue({
      ...value,
      archs: value.archs.map((entry, i): Architecture => (i === index ? { ...entry, [field]: text } : entry)),
    });
  };
  return (
    <div className="space-y-4">
      <label className="block space-y-1">
        Version
        <Input
          required
          value={value.version}
          onInput={(event): void => {
            setValue({ ...value, version: event.currentTarget.value });
          }}
          placeholder="0.2.0"
        />
      </label>
      <div className="flex flex-wrap gap-4">
        {(["official", "enabled", "beta", "deprecated"] as const).map(
          (field): React.JSX.Element => (
            <label key={field} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={value[field]}
                onChange={(event): void => {
                  setValue({
                    ...value,
                    [field]: event.target.checked,
                    ...(field === "deprecated" && !event.target.checked ? { "deprecated-reason": null } : {}),
                  });
                }}
              />
              {field === "enabled"
                ? "Enabled in catalog"
                : field === "official"
                  ? "Official"
                  : field === "beta"
                    ? "Beta"
                    : "Deprecated"}
            </label>
          ),
        )}
      </div>
      {value.official && (
        <p className="text-sm text-muted-foreground">Official versions cannot be deleted while marked official.</p>
      )}
      {value.deprecated && (
        <label className="block space-y-1">
          Deprecation reason
          <Input
            required
            value={value["deprecated-reason"] ?? ""}
            onInput={(event): void => {
              setValue({ ...value, "deprecated-reason": event.currentTarget.value });
            }}
          />
        </label>
      )}
      {value.archs.map(
        (entry, index): React.JSX.Element => (
          <fieldset key={index} className="space-y-3 rounded-md border p-3">
            <legend className="px-1 text-sm">Linux binary {index + 1}</legend>
            <label className="block space-y-1">
              Architecture
              <Select
                value={entry.arch}
                onChange={(event): void => {
                  changeArch(index, "arch", event.target.value);
                }}
              >
                <option value="amd64">amd64</option>
                <option value="arm64">arm64</option>
                <option value="s390x">s390x</option>
              </Select>
            </label>
            <label className="block space-y-1">
              Download URL
              <Input
                type="url"
                required
                value={entry.url}
                onInput={(event): void => {
                  changeArch(index, "url", event.currentTarget.value);
                }}
              />
            </label>
            <label className="block space-y-1">
              SHA-256
              <Input
                required
                autoComplete="off"
                value={entry.sha}
                onInput={(event): void => {
                  changeArch(index, "sha", event.currentTarget.value);
                }}
              />
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={value.archs.length === 1}
              onClick={(): void => {
                setValue({ ...value, archs: value.archs.filter((_, i): boolean => i !== index) });
              }}
            >
              Remove binary {index + 1}
            </Button>
          </fieldset>
        ),
      )}
      <Button
        type="button"
        variant="outline"
        disabled={value.archs.length >= 3}
        onClick={(): void => {
          const arch = ["amd64", "arm64", "s390x"].find(
            (candidate): boolean => !value.archs.some((entry): boolean => entry.arch === candidate),
          );
          setValue({ ...value, archs: [...value.archs, { ...emptyArchitecture(), arch: arch ?? "amd64" }] });
        }}
      >
        Add binary
      </Button>
    </div>
  );
}

export function TfpolicyVersionsAdmin(): React.JSX.Element {
  const [versions, setVersions] = useState<Version[]>([]);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<VersionAttributes>(emptyVersion);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Version | null>(null);
  useEffect((): (() => void) => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetchApi(`/admin/tfpolicy-versions?page[size]=20&page[number]=${page}`, { signal: controller.signal })
      .then((result): void => {
        if (controller.signal.aborted) return;
        const response = result as { data: Version[]; meta?: { pagination?: { "next-page"?: number | null } } };
        setVersions(response.data);
        setHasNext(response.meta?.pagination?.["next-page"] != null);
      })
      .catch((reason: unknown): void => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : "Failed to load tfpolicy versions.");
      })
      .finally((): void => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return (): void => {
      controller.abort();
    };
  }, [page, revision]);
  const save = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const invalid = validateTfpolicyVersion(value);
    if (invalid !== null) {
      setFormError(invalid);
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      await fetchApi(`/admin/tfpolicy-versions${editing === null ? "" : `/${encodeURIComponent(editing)}`}`, {
        method: editing === null ? "POST" : "PATCH",
        body: JSON.stringify({
          data: {
            type: "tfpolicy-versions",
            attributes: { ...value, "deprecated-reason": value.deprecated ? value["deprecated-reason"] : null },
          },
        }),
      });
      setOpen(false);
      setRevision((r): number => r + 1);
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Failed to save version.");
    } finally {
      setSaving(false);
    }
  };
  const remove = async (): Promise<void> => {
    if (deleting === null || deleting.attributes.official) return;
    setSaving(true);
    setError("");
    try {
      await fetchApi(`/admin/tfpolicy-versions/${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
      setDeleting(null);
      if (versions.length === 1 && page > 1) setPage(page - 1);
      else setRevision((r): number => r + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to delete version.");
      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card>
      <CardHeader variant="section">
        <CardTitle>tfpolicy version catalog</CardTitle>
        <CardDescription>
          Register binary metadata for provider compatibility. tfpolicy execution is unsupported: applicable policies
          block runs and Stack deployments. Catalog registration or enabling a version does not enable an executor.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          onClick={(): void => {
            setEditing(null);
            setValue(emptyVersion());
            setFormError("");
            setOpen(true);
          }}
        >
          Register tfpolicy version
        </Button>
        {error !== "" && (
          <div role="alert">
            <p className="text-destructive">{error}</p>
            <Button
              variant="outline"
              onClick={(): void => {
                setRevision((r): number => r + 1);
              }}
            >
              Retry catalog
            </Button>
          </div>
        )}
        {loading ? (
          <p role="status">Loading tfpolicy versions…</p>
        ) : (
          error === "" && (
            <>
              {versions.length === 0 && <p>No tfpolicy versions registered.</p>}
              {versions.map(
                (version): React.JSX.Element => (
                  <div className="rounded-md border p-3 space-y-2" key={version.id}>
                    <p className="font-medium">tfpolicy {version.attributes.version}</p>
                    <p className="text-sm text-muted-foreground">
                      {version.attributes.enabled ? "Enabled in catalog" : "Disabled in catalog"}
                      {version.attributes.official ? " · Official" : " · Custom"}
                      {version.attributes.beta ? " · Beta" : ""}
                      {version.attributes.deprecated
                        ? ` · Deprecated: ${version.attributes["deprecated-reason"] ?? ""}`
                        : ""}
                    </p>
                    <p className="text-sm">
                      {version.attributes.archs.map((arch): string => `${arch.os}/${arch.arch}`).join(", ")}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={(): void => {
                          setEditing(version.id);
                          setValue({
                            ...version.attributes,
                            archs: version.attributes.archs.map((a): Architecture => ({ ...a })),
                          });
                          setFormError("");
                          setOpen(true);
                        }}
                      >
                        Edit tfpolicy {version.attributes.version}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={version.attributes.official || saving}
                        onClick={(): void => {
                          setDeleting(version);
                        }}
                      >
                        Delete tfpolicy {version.attributes.version}
                      </Button>
                    </div>
                  </div>
                ),
              )}
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  disabled={page === 1}
                  onClick={(): void => {
                    setPage(page - 1);
                  }}
                >
                  Previous versions
                </Button>
                <span>Page {page}</span>
                <Button
                  variant="outline"
                  disabled={!hasNext}
                  onClick={(): void => {
                    setPage(page + 1);
                  }}
                >
                  Next versions
                </Button>
              </div>
            </>
          )
        )}
        <Dialog
          open={open}
          onOpenChange={(next): void => {
            if (!saving) setOpen(next);
          }}
        >
          <DialogContent className="max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editing === null ? "Register tfpolicy version" : "Edit tfpolicy version"}</DialogTitle>
              <DialogDescription>
                Catalog metadata only. Saving does not enable tfpolicy execution. Editing replaces the complete list of
                architecture binaries.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={save} className="space-y-4">
              <VersionEditor value={value} setValue={setValue} />
              {formError !== "" && (
                <p role="alert" className="text-destructive">
                  {formError}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={(): void => {
                    setOpen(false);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving…" : "Save tfpolicy version"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
        <ConfirmDialog
          open={deleting !== null}
          onOpenChange={(next): void => {
            if (!next && !saving) setDeleting(null);
          }}
          title="Delete tfpolicy version"
          description={`Remove ${deleting?.attributes.version ?? "this version"} from the catalog? Policy sets referencing it are not changed.`}
          confirmText="Delete version"
          confirmVariant="destructive"
          loading={saving}
          onConfirm={remove}
        />
      </CardContent>
    </Card>
  );
}
