import { useCallback, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError, fetchAllApiPages, fetchApi } from "@/lib/api";
import { cn } from "@/lib/utils";

type Resource = Readonly<{
  id: string;
  attributes: Readonly<{
    address: string;
    module?: string;
    provider?: string;
    "provider-type"?: string;
    "updated-at"?: string;
  }>;
}>;

type Output = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    sensitive?: boolean;
    type?: string;
    value?: unknown;
  }>;
}>;

type Tab = "outputs" | "resources";

function outputValue(output: Output): string {
  if (output.attributes.sensitive === true) return "Sensitive value";
  const value = output.attributes.value;
  if (typeof value === "string") return value;
  if (value === undefined) return "—";
  return JSON.stringify(value);
}

function formatDate(value: string | undefined): string {
  const date = new Date(value ?? "");
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString();
}

export function WorkspaceResources({
  workspaceId,
}: Readonly<{ workspaceId: string }>): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("resources");
  const [resources, setResources] = useState<Resource[]>([]);
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [resourceError, setResourceError] = useState("");
  const [outputError, setOutputError] = useState("");

  const load = useCallback(async (signal?: Readonly<AbortSignal>): Promise<void> => {
    setLoading(true);
    setResourceError("");
    setOutputError("");
    const [resourceResult, outputResult] = await Promise.allSettled([
      fetchAllApiPages<Resource>(
        `/workspaces/${encodeURIComponent(workspaceId)}/resources?page[size]=100`,
        signal,
      ),
      fetchApi(
        `/workspaces/${encodeURIComponent(workspaceId)}/current-state-version-outputs`,
        signal === undefined ? {} : { signal },
      ),
    ]);
    if (signal?.aborted === true) return;
    if (resourceResult.status === "fulfilled") {
      setResources(resourceResult.value);
    } else {
      setResourceError(resourceResult.reason instanceof Error
        ? resourceResult.reason.message
        : "Could not load resources");
    }
    if (outputResult.status === "fulfilled") {
      const data = (outputResult.value as { data?: Output[] }).data;
      setOutputs(Array.isArray(data) ? data : []);
    } else if (outputResult.reason instanceof ApiError && outputResult.reason.status === 404) {
      setOutputs([]);
    } else {
      setOutputError(outputResult.reason instanceof Error
        ? outputResult.reason.message
        : "Could not load outputs");
    }
    setLoading(false);
  }, [workspaceId]);

  useEffect((): (() => void) => {
    const controller = new AbortController();
    void load(controller.signal);
    return (): void => {
      controller.abort();
    };
  }, [load]);

  const needle = search.trim().toLowerCase();
  const visibleResources = useMemo(
    (): Resource[] => resources.filter((resource): boolean =>
      needle === "" || [
        resource.attributes.address,
        resource.attributes.module,
        resource.attributes.provider,
        resource.attributes["provider-type"],
      ].some((value): boolean => value?.toLowerCase().includes(needle) === true)),
    [needle, resources],
  );
  const visibleOutputs = useMemo(
    (): Output[] => outputs.filter((output): boolean =>
      needle === "" || output.attributes.name.toLowerCase().includes(needle)),
    [needle, outputs],
  );
  const activeError = tab === "resources" ? resourceError : outputError;

  return (
    <section aria-labelledby="workspace-state-heading" className="overflow-hidden rounded-md border bg-card">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b px-5 py-4">
        <div>
          <h2 id="workspace-state-heading" className="font-semibold">Current state</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Browse the resources and outputs in the latest state version.
          </p>
        </div>
        <div role="tablist" aria-label="Current state views" className="flex gap-1 rounded-md bg-muted p-1">
          {(["resources", "outputs"] as const).map((value): React.JSX.Element => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={(): void => {
                setTab(value);
                setSearch("");
              }}
              className={cn(
                "rounded px-3 py-1.5 text-sm font-medium capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tab === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
              )}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <div className="border-b p-4">
        <div className="relative max-w-md">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={`Search ${tab}`}
            className="pl-9"
            value={search}
            placeholder={`Search ${tab}`}
            onInput={(event): void => { setSearch(event.currentTarget.value); }}
          />
        </div>
      </div>

      {loading ? (
        <div className="flex min-h-36 items-center justify-center"><Spinner aria-label="Loading current state" /></div>
      ) : activeError !== "" ? (
        <div role="alert" className="min-h-36 p-6 text-center">
          <p className="font-medium text-destructive">Could not load {tab}</p>
          <p className="mt-1 text-sm text-muted-foreground">{activeError}</p>
          <Button className="mt-3" size="sm" variant="outline" onClick={(): void => { void load(); }}>
            Try again
          </Button>
        </div>
      ) : tab === "resources" ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Address</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Module</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleResources.map((resource): React.JSX.Element => (
              <TableRow key={resource.id}>
                <TableCell className="font-mono text-xs">{resource.attributes.address}</TableCell>
                <TableCell>{resource.attributes.provider ?? "—"}</TableCell>
                <TableCell>{resource.attributes["provider-type"] ?? "—"}</TableCell>
                <TableCell>{resource.attributes.module ?? "root"}</TableCell>
                <TableCell>
                  <time dateTime={resource.attributes["updated-at"]}>
                    {formatDate(resource.attributes["updated-at"])}
                  </time>
                </TableCell>
              </TableRow>
            ))}
            {visibleResources.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="h-28 text-center text-muted-foreground">
                  {resources.length === 0 ? "No resources are recorded in the current state." : "No resources match this search."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Type</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleOutputs.map((output): React.JSX.Element => (
              <TableRow key={output.id}>
                <TableCell className="font-mono text-xs">{output.attributes.name}</TableCell>
                <TableCell className={output.attributes.sensitive === true ? "italic text-muted-foreground" : "font-mono text-xs"}>
                  {outputValue(output)}
                </TableCell>
                <TableCell>{output.attributes.type ?? "—"}</TableCell>
              </TableRow>
            ))}
            {visibleOutputs.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="h-28 text-center text-muted-foreground">
                  {outputs.length === 0 ? "No outputs are recorded in the current state." : "No outputs match this search."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
