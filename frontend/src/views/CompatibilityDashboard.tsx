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

type SurfaceEntry = Readonly<{ name: string; status: string }>;

type ProviderSurface = Readonly<{
  provider?: string;
  resource_count?: number;
  data_source_count?: number;
  resources_covered?: number;
  data_sources_covered?: number;
  resources?: SurfaceEntry[];
  data_sources?: SurfaceEntry[];
}>;

const STATUS_STYLES: Readonly<Record<string, string>> = {
  covered: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-950/40 dark:text-emerald-300",
  planned: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800/50 dark:bg-sky-950/40 dark:text-sky-300",
  "backend-gap": "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/40 dark:text-amber-300",
  admin: "border-purple-200 bg-purple-50 text-purple-800 dark:border-purple-800/50 dark:bg-purple-950/40 dark:text-purple-300",
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
              <Badge variant="outline" className={cn("rounded font-mono", STATUS_STYLES[entry.status])}>
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
  const dataSources = data?.data_sources ?? [];
  const coveredResources = resources.filter((entry): boolean => entry.status === "covered").length;
  const coveredDataSources = dataSources.filter((entry): boolean => entry.status === "covered").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Provider compatibility</h1>
        <p className="mt-1 text-[15px] text-muted-foreground">
          {data?.provider ?? "hashicorp/tfe"} API surface: which resources and data sources the Terrence
          backend can actually serve, tracked by the provider E2E suite.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Spinner aria-label="Loading provider surface" /></div>
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
              <CardHeader><CardTitle className="text-sm">Resources</CardTitle></CardHeader>
              <CardContent className="text-2xl font-bold">{data.resource_count ?? resources.length}</CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Data sources</CardTitle></CardHeader>
              <CardContent className="text-2xl font-bold">{data.data_source_count ?? dataSources.length}</CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Covered resources</CardTitle></CardHeader>
              <CardContent className="text-2xl font-bold text-emerald-600">{coveredResources}</CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Covered data sources</CardTitle></CardHeader>
              <CardContent className="text-2xl font-bold text-emerald-600">{coveredDataSources}</CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="text-lg">Resources</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="Filter resources"
                  placeholder="Search resources"
                  value={search}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setSearch(event.currentTarget.value); }}
                  className="h-9 w-56"
                />
                <Select aria-label="Status filter" value={statusFilter} onValueChange={setStatusFilter} className="h-9">
                  <option value="">All statuses</option>
                  <option value="covered">Covered</option>
                  <option value="planned">Planned</option>
                  <option value="backend-gap">Backend gap</option>
                  <option value="admin">Admin only</option>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <SurfaceTable entries={resources} statusFilter={statusFilter} search={search} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Data sources</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <SurfaceTable entries={dataSources} statusFilter={statusFilter} search={search} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}