import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { fetchApi } from "@/lib/api";

type Retention = {
  id: string;
  attributes: {
    "state-versions-count"?: number | null;
    "delete-older-than-n-days"?: number | null;
    "auto-destroy-at"?: string | null;
    "auto-destroy-activity-duration"?: string | null;
  };
};

export function WorkspaceRetention({ workspaceId }: Readonly<{ workspaceId: string }>): React.JSX.Element {
  const [policy, setPolicy] = useState<Retention | null>(null);
  const [count, setCount] = useState(0);
  const [days, setDays] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    void fetchApi<{ data?: { attributes?: { "max-days"?: number; "enabled"?: boolean } } }>(`/workspaces/${workspaceId}/relationships/data-retention-policy`)
      .then((response): void => {
        if (!active) return;
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const data = (response as { data?: Retention }).data;
        if (data === undefined) return;
        setPolicy(data);
        setCount(data.attributes["state-versions-count"] ?? 0);
        setDays(data.attributes["delete-older-than-n-days"] ?? 0);
      })
      .catch((caught): void => {
        if (active && !(caught instanceof Error && caught.message.includes("404"))) {
          setError(caught instanceof Error ? caught.message : "Could not load retention policy");
        }
      })
      .finally((): void => { if (active) setLoading(false); });
    return (): void => { active = false; };
  }, [workspaceId]);

  const save = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi(`/workspaces/${workspaceId}/relationships/data-retention-policy`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: days > 0 ? "data-retention-policy-delete-olders" : "data-retention-policy-dont-deletes",
            attributes: {
              "state-versions-count": count > 0 ? count : null,
              "delete-older-than-n-days": days > 0 ? days : null,
            },
          },
        }),
      }) as { data?: Retention };
      if (response.data !== undefined) setPolicy(response.data);
      setNotice("Retention policy saved.");
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not save retention policy");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div role="status" className="py-8 text-sm text-muted-foreground">Loading retention policy…</div>;

  return (
    <form onSubmit={save} className="max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Data retention</CardTitle>
          <CardDescription>Automatically clean up old state versions while keeping the current version available.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="retention-count">Keep state versions</FieldLabel>
              <Input id="retention-count" name="state-versions-count" type="number" inputMode="numeric" min="0" value={count} onChange={(event): void => { setCount(Number(event.target.value)); }} />
              <FieldDescription>Set to 0 to use age-based retention only.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="retention-days">Delete versions older than (days)</FieldLabel>
              <Input id="retention-days" name="delete-older-than-days" type="number" inputMode="numeric" min="0" value={days} onChange={(event): void => { setDays(Number(event.target.value)); }} />
              <FieldDescription>Set to 0 to retain state indefinitely by age.</FieldDescription>
            </Field>
            <FieldError>{error}</FieldError>
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-between">
          <span role="status" className="text-sm text-muted-foreground">{notice || (policy === null ? "No policy configured." : "")}</span>
          <Button type="submit" disabled={saving}>{saving && <Spinner data-icon="inline-start" />}{saving ? "Saving…" : "Save policy"}</Button>
        </CardFooter>
      </Card>
    </form>
  );
}