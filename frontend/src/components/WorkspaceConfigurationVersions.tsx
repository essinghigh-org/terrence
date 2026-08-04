import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { toast } from "../components/ui/toast";

type ConfigurationVersion = { id: string; attributes: { status?: string; source?: string; speculative?: boolean; "created-at"?: string; [key: string]: unknown } };

export function WorkspaceConfigurationVersions({ workspaceId }: Readonly<{ workspaceId: string }>): React.JSX.Element {
  const [versions, setVersions] = useState<ConfigurationVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const load = async (): Promise<void> => {
    const response = await fetchApi(`/workspaces/${workspaceId}/configuration-versions?page[size]=50`) as { data?: ConfigurationVersion[] };
    setVersions(Array.isArray(response.data) ? response.data : []);
  };
  useEffect(() => { void load().catch((caught: unknown) => { setError(caught instanceof Error ? caught.message : "Could not load configuration versions"); }).finally(() => { setLoading(false); }); }, [workspaceId]);
  const createVersion = async (): Promise<void> => {
    setCreating(true); setError("");
    try {
      const response = await fetchApi(`/workspaces/${workspaceId}/configuration-versions`, { method: "POST", body: JSON.stringify({ data: { type: "configuration-versions", attributes: { source: "tfe-api" } } }) }) as { data: ConfigurationVersion };
      setVersions((current) => [response.data, ...current]); toast.add({ title: "Configuration version created", description: "Upload configuration content with the API upload URL.", type: "success" });
    } catch (caught: unknown) { setError(caught instanceof Error ? caught.message : "Could not create configuration version"); } finally { setCreating(false); }
  };
  return <Card className="max-w-4xl">
    <CardHeader className="flex-row items-start justify-between gap-4"><div><CardTitle>Configuration versions</CardTitle><CardDescription>Prepare and track configuration archives for this workspace.</CardDescription></div><Button type="button" onClick={() => void createVersion()} disabled={creating}>{creating ? "Creating…" : "New version"}</Button></CardHeader>
    <CardContent>{error !== "" && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}{loading ? <p className="text-sm text-muted-foreground">Loading configuration versions…</p> : <div className="divide-y rounded-md border">{versions.map((version) => <div className="flex items-center justify-between px-4 py-3" key={version.id}><div><p className="font-mono text-sm">{version.id}</p><p className="text-xs text-muted-foreground">{version.attributes.source ?? "API"}{typeof version.attributes["created-at"] === "string" && version.attributes["created-at"] !== "" ? ` · ${new Date(version.attributes["created-at"]).toLocaleString()}` : ""}</p></div><span className="rounded-full bg-muted px-2 py-1 text-xs">{version.attributes.status ?? "pending"}</span></div>)}{versions.length === 0 && <p className="px-4 py-6 text-sm text-muted-foreground">No configuration versions yet.</p>}</div>}</CardContent>
  </Card>;
}

export function configurationVersionStatus(version: ConfigurationVersion): string { return version.attributes.status ?? "pending"; }
