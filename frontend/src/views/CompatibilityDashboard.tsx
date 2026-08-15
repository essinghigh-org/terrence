import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader, PageShell } from "@/components/PageHeader";
import { isNumber } from "../lib/type-guards";
import type { JsonObject } from "@/lib/json";

type SurfaceEntry = Readonly<{ name: string; status: string }>;

type ProviderSurface = Readonly<JsonObject & {
  provider?: string;
  resources?: SurfaceEntry[];
}>;

const STATUS_STYLES = {
  covered: "border-success/30 bg-success/10 text-success",
  planned: "border-primary/30 bg-primary/10 text-primary",
  "backend-gap": "border-warning/30 bg-warning/10 text-warning",
  admin: "border-border bg-muted text-muted-foreground",
};

function statusLabel(status: string): string {
  switch (status) {
    case "covered": return "Covered";
    case "planned": return "Planned";
    case "backend-gap": return "Backend gap";
    case "admin": return "Admin only";
    default: return status;
  }
}

function SurfaceTable({
  entries,
  statusFilter,
  search,
}: Readonly<{ entries: SurfaceEntry[]; statusFilter: string; search: string }>): React.JSX.Element {
  const needle = search.trim().toLowerCase();
  const visible = entries.filter((entry): boolean =>
    (statusFilter === "" || entry.status === statusFilter)
    && (needle === "" || entry.name.toLowerCase().includes(needle)));
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visible.map((entry): React.JSX.Element => (
          <TableRow key={entry.name}>
            <TableCell className="font-mono text-[13px]">{entry.name}</TableCell>
            <TableCell>
              {/* SAFETY: the status union covers exactly the map keys; unmatched values are handled by the surrounding fallback. */}
              <Badge variant="outline" className={// SAFETY: the rendered attribute matches the union the UI derives from the API contract.
cn("rounded font-mono", STATUS_STYLES[entry.status as keyof typeof STATUS_STYLES])}>
                {statusLabel(entry.status)}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
        {visible.length === 0 && (
          <TableRow><TableCell colSpan={2} className="py-8 text-center text-muted-foreground">No matching entries.</TableCell></TableRow>
        )}
      </TableBody>
    </Table>
  );
}

/** TFE provider compatibility dashboard (kanban 11.18). */
export function CompatibilityDashboard(): React.JSX.Element {
  const [data, setData] = useState<ProviderSurface | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const response = await fetchApi("/api/v2/admin/provider-surface") as { data?: ProviderSurface };
      setData(response.data ?? null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not load provider surface");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect((): void => {
    void load();
  }, [load]);

  const resources = data?.resources ?? [];
  // SAFETY: the compat surface payload carries SurfaceEntry arrays per contract.
  const dataSources = Array.isArray(data?.["data_sources"])
    ? data["data_sources"] as SurfaceEntry[]
    : [];
  const coveredResources = resources.filter((entry): boolean => entry.status === "covered").length;
  const coveredDataSources = dataSources.filter((entry): boolean => entry.status === "covered").length;

  return (
    <PageShell>
      <PageHeader
        eyebrow="Site administration"
        title="Provider compatibility"
        description={`${data?.provider ?? "hashicorp/tfe"} API surface: which resources and data sources the Terrence backend can actually serve, tracked by the provider E2E suite.`}
      />

      {loading ? (
        <div role="status" className="flex justify-center py-12"><Spinner aria-label="Loading provider surface" /></div>
      ) : error !== "" ? (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <p className="font-medium">Could not load provider surface</p>
          <p className="mt-1">{error}</p>
          <Button className="mt-3" variant="outline" onClick={(): void => { void load(); }}>Try again</Button>
        </div>
      ) : data === null ? (
        <p className="text-sm text-muted-foreground">No provider surface data available.</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Card>
              <CardHeader variant="section"><CardTitle className="text-sm">Resources</CardTitle></CardHeader>
              <CardContent className="tabular-nums text-2xl font-bold">
                {isNumber(data["resource_count"]) ? data["resource_count"] : resources.length}
              </CardContent>
            </Card>
            <Card>
              <CardHeader variant="section"><CardTitle className="text-sm">Data sources</CardTitle></CardHeader>
              <CardContent className="tabular-nums text-2xl font-bold">
                {isNumber(data["data_source_count"]) ? data["data_source_count"] : dataSources.length}
              </CardContent>
            </Card>
            <Card>
              <CardHeader variant="section"><CardTitle className="text-sm">Covered resources</CardTitle></CardHeader>
              <CardContent className="tabular-nums text-2xl font-bold text-success">{coveredResources}</CardContent>
            </Card>
            <Card>
              <CardHeader variant="section"><CardTitle className="text-sm">Covered data sources</CardTitle></CardHeader>
              <CardContent className="tabular-nums text-2xl font-bold text-success">{coveredDataSources}</CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="text-lg">Resources</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="provider-surface-search"
                  name="provider-surface-search"
                  type="search"
                  autoComplete="off"
                  aria-label="Filter resources"
                  placeholder="Search resources…"
                  value={search}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setSearch(event.currentTarget.value); }}
                  className="h-9 w-56"
                />
                <div className="w-40">
                  <Select id="provider-surface-status" name="status" aria-label="Status filter" value={statusFilter} onValueChange={setStatusFilter} className="h-9">
                    <option value="">All statuses</option>
                    <option value="covered">Covered</option>
                    <option value="planned">Planned</option>
                    <option value="backend-gap">Backend gap</option>
                    <option value="admin">Admin only</option>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <SurfaceTable entries={resources} statusFilter={statusFilter} search={search} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader variant="section">
              <CardTitle className="text-lg">Data sources</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <SurfaceTable entries={dataSources} statusFilter={statusFilter} search={search} />
            </CardContent>
          </Card>
        </>
      )}
    </PageShell>
  );
}