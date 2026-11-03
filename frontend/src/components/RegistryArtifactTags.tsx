import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

type Tag = Readonly<{ id: string; key: string; value: string }>;
type Props = Readonly<{
  kind: "modules" | "providers";
  artifactId: string;
  updatePath: string;
  canManage: boolean;
}>;

function validTags(tags: readonly Tag[]): boolean {
  return (
    tags.every((tag): boolean => tag.key.trim() !== "") &&
    new Set(tags.map((tag): string => tag.key)).size === tags.length
  );
}

export function RegistryArtifactTags({ kind, artifactId, updatePath, canManage }: Props): React.JSX.Element {
  const [tags, setTags] = useState<readonly Tag[]>([]);
  const [draft, setDraft] = useState<readonly Tag[]>([]);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [saved, setSaved] = useState(false);
  useEffect((): (() => void) => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchApi(`/registry-${kind}/${encodeURIComponent(artifactId)}/tag-bindings`, { signal: controller.signal })
      .then((response): void => {
        if (controller.signal.aborted) return;
        // SAFETY: the registry tag-bindings endpoint returns this JSON:API resource shape.
        const result = response as { data: { id: string; attributes: { key: string; value: string } }[] };
        setTags(result.data.map((tag): Tag => ({ id: tag.id, ...tag.attributes })));
      })
      .catch((caught: unknown): void => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Unable to load tags.");
      })
      .finally((): void => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return (): void => {
      controller.abort();
    };
  }, [artifactId, kind, reload]);

  const valid = validTags(draft);
  const save = async (): Promise<void> => {
    if (!canManage || !valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await fetchApi(updatePath, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            type: `registry-${kind}`,
            relationships: {
              "tag-bindings": {
                data: draft.map((tag): object => ({
                  type: "tag-bindings",
                  attributes: { key: tag.key, value: tag.value },
                })),
              },
            },
          },
        }),
      });
      setTags(draft);
      setEditing(false);
      setSaved(true);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Unable to save tags.");
    } finally {
      setSaving(false);
    }
  };
  const change = (id: string, field: "key" | "value", value: string): void => {
    setDraft((current): readonly Tag[] =>
      current.map((tag): Tag => (tag.id === id ? { ...tag, [field]: value } : tag)),
    );
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Artifact tags</CardTitle>
        <CardDescription>
          Key/value metadata for this registry artifact. These are separate from Git release tags.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p role="status">Loading artifact tags…</p>
        ) : editing && canManage ? (
          <form
            className="space-y-3"
            onSubmit={(event): void => {
              event.preventDefault();
              void save();
            }}
          >
            {draft.map(
              (tag, index): React.JSX.Element => (
                <div key={tag.id} className="flex flex-wrap items-center gap-2">
                  <Input
                    className="w-48"
                    aria-label={`Tag ${index + 1} key`}
                    placeholder="Key"
                    value={tag.key}
                    disabled={saving}
                    onInput={(event): void => {
                      change(tag.id, "key", event.currentTarget.value);
                    }}
                  />
                  <Input
                    className="w-48"
                    aria-label={`Tag ${index + 1} value`}
                    placeholder="Value (optional)"
                    value={tag.value}
                    disabled={saving}
                    onInput={(event): void => {
                      change(tag.id, "value", event.currentTarget.value);
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={saving}
                    aria-label={`Remove tag ${index + 1}`}
                    onClick={(): void => {
                      setDraft((current): readonly Tag[] => current.filter((item): boolean => item.id !== tag.id));
                    }}
                  >
                    Remove
                  </Button>
                </div>
              ),
            )}
            {draft.length === 0 && (
              <p className="text-sm text-muted-foreground">No tags. Saving will remove all existing tags.</p>
            )}
            {!valid && <p role="alert">Each tag needs a unique, nonempty key.</p>}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={(): void => {
                  setDraft((current): readonly Tag[] => [...current, { id: crypto.randomUUID(), key: "", value: "" }]);
                }}
              >
                Add tag
              </Button>
              <Button type="submit" disabled={saving || !valid}>
                {saving ? "Saving…" : "Save tags"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={(): void => {
                  setEditing(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            {error !== null ? null : tags.length === 0 ? (
              <p className="text-sm text-muted-foreground">No artifact tags.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {tags.map(
                  (tag): React.JSX.Element => (
                    <Badge key={tag.id} variant="secondary" className="max-w-full whitespace-normal break-all">
                      {tag.key}
                      {tag.value === "" ? "" : `: ${tag.value}`}
                    </Badge>
                  ),
                )}
              </div>
            )}
            {canManage && error === null && (
              <Button
                type="button"
                variant="outline"
                onClick={(): void => {
                  setDraft(tags);
                  setEditing(true);
                  setSaved(false);
                }}
              >
                Edit tags
              </Button>
            )}
          </>
        )}
        {error !== null && (
          <div role="alert">
            <p>{error}</p>
            {!editing && (
              <Button
                type="button"
                variant="outline"
                onClick={(): void => {
                  setReload((value): number => value + 1);
                }}
              >
                Retry loading tags
              </Button>
            )}
          </div>
        )}
        {saved && <p role="status">Artifact tags saved.</p>}
      </CardContent>
    </Card>
  );
}
