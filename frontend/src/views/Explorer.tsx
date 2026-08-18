import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useParams } from "react-router-dom";
import { Download, Play, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import { fetchApi, getAuthToken } from "../lib/api";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Select, SelectItem } from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { PageHeader, PageShell } from "../components/PageHeader";

type ViewType = "workspaces" | "tf_versions" | "providers" | "modules";
type ExplorerResource = Readonly<{ id: string; type: string; attributes: Record<string, unknown> }>;
type SavedView = Readonly<{
  id: string;
  attributes: Readonly<{ name: string; "created-at"?: string; query?: { type?: ViewType; filter?: { field?: string; value?: string[] }[] } }>;
}>;

const viewLabels: Record<ViewType, string> = {
  workspaces: "Workspaces",
  tf_versions: "Terraform versions",
  providers: "Providers",
  modules: "Modules",
};

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function Explorer(): JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [viewType, setViewType] = useState<ViewType>("workspaces");
  const [search, setSearch] = useState("");
  const [saveName, setSaveName] = useState("");
  const [rows, setRows] = useState<ExplorerResource[]>([]);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;

  const endpoint = useMemo((): string => {
    const params = new URLSearchParams({ type: viewType, "page[size]": "100" });
    if (search.trim() !== "") params.set("filter[0][workspace_name][contains][0]", search.trim());
    return `/organizations/${encodeURIComponent(orgName)}/explorer?${params.toString()}`;
  }, [orgName, search, viewType]);

  const load = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    try {
      const [result, saved] = await Promise.all([
        fetchApi(endpoint) as Promise<{ data: ExplorerResource[] }>,
        fetchApi(`/organizations/${encodeURIComponent(requestedOrganizationName)}/explorer/views`) as Promise<{ data: SavedView[] }>,
      ]);
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      setRows(result.data ?? []);
      setSavedViews(saved.data ?? []);
    } catch (reason) {
      if (activeOrganizationName.current === requestedOrganizationName) setError(reason instanceof Error ? reason.message : "Explorer query failed.");
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
    }
  };

  useEffect((): void => { void load(); }, [endpoint, orgName]);

  const runQuery = async (): Promise<void> => { await load(); };

  const saveView = async (): Promise<void> => {
    const name = saveName.trim();
    if (name === "") { setError("Enter a name before saving this view."); return; }
    setBusy(true);
    setError("");
    try {
      await fetchApi(`/organizations/${encodeURIComponent(orgName)}/explorer/views`, {
        method: "POST",
        body: JSON.stringify({ data: { name, query_type: viewType, query: { type: viewType, filter: search.trim() === "" ? [] : [{ field: "workspace_name", operator: "contains", value: [search.trim()] }], fields: [], sort: [] } } }),
      });
      setSaveName("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the view.");
    } finally {
      setBusy(false);
    }
  };

  const deleteView = async (view: SavedView): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await fetchApi(`/organizations/${encodeURIComponent(orgName)}/explorer/views/${encodeURIComponent(view.id)}`, { method: "DELETE" });
      setSavedViews((current) => current.filter((item) => item.id !== view.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete the view.");
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async (): Promise<void> => {
    const token = getAuthToken();
    if (token === null) { setError("Your session has expired. Sign in again to export data."); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/v2${endpoint.replace("/explorer?", "/explorer/export/csv?")}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Export failed (${response.status}).`);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(await response.blob());
      link.download = `explorer-${viewType}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not export data.");
    } finally {
      setBusy(false);
    }
  };

  const applySavedView = (view: SavedView): void => {
    const query = view.attributes.query;
    if (query?.type !== undefined) setViewType(query.type);
    const filter = query?.filter?.find((item) => item.field === "workspace_name");
    setSearch(filter?.value?.[0] ?? "");
  };

  const firstRow = rows[0];
  const columns = firstRow === undefined ? [] : Object.keys(firstRow.attributes).slice(0, 8);

  return (
    <PageShell>
      <PageHeader
        eyebrow="Organization data / live query"
        title="Explorer"
        description="Query the current state of workspaces, versions, providers, and modules without leaving Terrence."
        action={<Button variant="outline" onClick={(): void => { void exportCsv(); }} disabled={busy || loading}><Download className="size-4" aria-hidden="true" />Export CSV</Button>}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-6">
          <Card className="border-l-2 border-l-amber-500">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Search className="size-4 text-amber-600" aria-hidden="true" />Build a query</CardTitle>
              <CardDescription>Results are live and scoped to this organization.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto]">
                <Select aria-label="Explorer view" value={viewType} onValueChange={(value): void => { setViewType(value as ViewType); }}>
                  {(Object.keys(viewLabels) as ViewType[]).map((type): JSX.Element => <SelectItem key={type} value={type}>{viewLabels[type]}</SelectItem>)}
                </Select>
                <Input aria-label="Filter workspace name" placeholder="Filter workspace name" value={search} onChange={(event): void => { setSearch(event.target.value); }} />
                <Button onClick={(): void => { void runQuery(); }} disabled={loading}><Play className="size-4" aria-hidden="true" />Run query</Button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Input className="max-w-xs" aria-label="Saved view name" placeholder="Name this view" value={saveName} onChange={(event): void => { setSaveName(event.target.value); }} />
                <Button variant="outline" onClick={(): void => { void saveView(); }} disabled={busy}><Save className="size-4" aria-hidden="true" />Save view</Button>
                <Button variant="ghost" onClick={(): void => { void load(); }} disabled={loading}><RefreshCw className="size-4" aria-hidden="true" />Refresh</Button>
              </div>
            </CardContent>
          </Card>

          {error !== "" && <Card className="border-destructive/40 bg-destructive/5"><CardContent className="pt-6 text-sm text-destructive">{error}</CardContent></Card>}

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div><CardTitle>{viewLabels[viewType]}</CardTitle><CardDescription>{rows.length} row{rows.length === 1 ? "" : "s"} on this page</CardDescription></div>
              {loading && <Spinner className="size-5" />}
            </CardHeader>
            <CardContent className="pt-0">
              {rows.length === 0 && !loading ? <p className="py-10 text-center text-sm text-muted-foreground">No data matched this query.</p> : (
                <Table density="dense">
                  <TableHeader><TableRow>{columns.map((column): JSX.Element => <TableHead key={column}>{column.split("_").join(" ")}</TableHead>)}</TableRow></TableHeader>
                  <TableBody>{rows.map((row): JSX.Element => <TableRow key={row.id}>{columns.map((column): JSX.Element => <TableCell key={`${row.id}-${column}`} className="max-w-72 truncate">{displayValue(row.attributes[column])}</TableCell>)}</TableRow>)}</TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader><CardTitle>Saved views</CardTitle><CardDescription>Reusable query definitions for this organization.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            {savedViews.length === 0 ? <p className="text-sm text-muted-foreground">No saved views yet.</p> : savedViews.map((view): JSX.Element => (
              <div key={view.id} className="group flex items-center gap-2 rounded-lg border border-border/70 p-2">
                <button type="button" className="min-w-0 flex-1 text-left text-sm font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={(): void => { applySavedView(view); }}>{view.attributes.name}</button>
                <Button variant="ghost" size="icon-xs" aria-label={`Delete ${view.attributes.name}`} onClick={(): void => { void deleteView(view); }} disabled={busy}><Trash2 className="size-3.5" aria-hidden="true" /></Button>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}

export { Explorer };
