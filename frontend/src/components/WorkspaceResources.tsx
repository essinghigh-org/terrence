import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DependencyGraph, type DependencyGraphResource, type ResourceDetails } from "@/components/DependencyGraph";
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
import { cn, formatDateTime } from "@/lib/utils";

const PAGE_SIZE = 20;

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

type Readme = Readonly<{
  content: string;
  "run-id"?: string;
  "created-at"?: string;
}>;

type Tab = "outputs" | "resources" | "graph";

type DependencyGraphState = Readonly<{
  nodes: readonly DependencyGraphResource[];
}>;

type ReadmeBlock =
  | Readonly<{ kind: "heading"; level: 1 | 2 | 3; text: string }>
  | Readonly<{ kind: "paragraph" | "quote" | "code"; text: string }>
  | Readonly<{ kind: "list"; items: string[] }>;

function outputValue(output: Output): string {
  if (output.attributes.sensitive === true) return "Sensitive value";
  const value = output.attributes.value;
  if (typeof value === "string") return value;
  if (value === undefined) return "—";
  return JSON.stringify(value);
}

function formatDate(value: string | undefined): string {
  const date = new Date(value ?? "");
  return formatDateTime(date);
}

function isAborted(signal: Readonly<AbortSignal> | undefined): boolean {
  return signal?.aborted === true;
}

function inlineMarkdown(text: string): React.ReactNode {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^\)]+\))/g).map((part: string, index: number): React.ReactNode => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^\)]+)\)$/.exec(part);
    if (link !== null) {
      const href = link[2] ?? "";
      const safe = href.startsWith("/") || href.startsWith("./") || href.startsWith("#") || /^(https?:|mailto:)/.test(href);
      return safe
        ? <a key={index} href={href} className="text-primary underline underline-offset-2" target={href.startsWith("http") ? "_blank" : undefined} rel={href.startsWith("http") ? "noreferrer" : undefined}>{link[1]}</a>
        : link[1];
    }
    return part;
  });
}

function parseReadme(markdown: string): ReadmeBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReadmeBlock[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const fence = /^```(?:\w+)?$/.test(line.trim());
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (current.trim().startsWith("```")) break;
        code.push(current);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading !== null) {
      blocks.push({ kind: "heading", level: (heading[1] ?? "").length as 1 | 2 | 3, text: heading[2] ?? "" });
      index += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (!/^\s*[-*+]\s+/.test(current)) break;
        items.push(current.replace(/^\s*[-*+]\s+/, ""));
        index += 1;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (line.startsWith("> ")) {
      blocks.push({ kind: "quote", text: line.slice(2) });
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (current.trim() === "" || /^```(?:\w+)?$/.test(current.trim()) || /^(#{1,3})\s+/.test(current) || /^\s*[-*+]\s+/.test(current) || current.startsWith("> ")) break;
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

function ReadmePreview({ readme }: Readonly<{ readme: Readme }>): React.JSX.Element {
  const blocks = useMemo((): ReadmeBlock[] => parseReadme(readme.content), [readme.content]);

  return (
    <section aria-labelledby="workspace-readme-heading" className="border-t bg-muted/20 px-5 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileText className="size-4" aria-hidden="true" />
          </span>
          <div>
            <h3 id="workspace-readme-heading" className="font-semibold">README.md</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              From the most recent run{readme["created-at"] !== undefined ? ` · ${formatDate(readme["created-at"])} ` : ""}
            </p>
          </div>
        </div>
        {readme["run-id"] !== undefined && <code className="text-xs text-muted-foreground">{readme["run-id"]}</code>}
      </div>
      <div className="mt-4 max-h-[36rem] overflow-auto rounded-lg border bg-background px-5 py-4 text-sm leading-6">
        <div className="space-y-4">
          {blocks.map((block, index): React.JSX.Element => {
            if (block.kind === "heading") {
              const headingClassName = cn("font-semibold tracking-tight", block.level === 1 ? "text-xl" : block.level === 2 ? "text-lg" : "text-base");
              if (block.level === 1) return <h1 key={index} className={headingClassName}>{inlineMarkdown(block.text)}</h1>;
              if (block.level === 2) return <h2 key={index} className={headingClassName}>{inlineMarkdown(block.text)}</h2>;
              return <h3 key={index} className={headingClassName}>{inlineMarkdown(block.text)}</h3>;
            }
            if (block.kind === "list") {
              return <ul key={index} className="list-disc space-y-1 pl-5">{block.items.map((item, itemIndex): React.JSX.Element => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ul>;
            }
            if (block.kind === "code") return <pre key={index} className="overflow-x-auto rounded-md bg-code-background p-4 font-mono text-xs leading-5 text-code-foreground"><code>{block.text}</code></pre>;
            if (block.kind === "quote") return <blockquote key={index} className="border-l-2 border-primary/40 pl-4 italic text-muted-foreground">{inlineMarkdown(block.text)}</blockquote>;
            return <p key={index}>{inlineMarkdown(block.text)}</p>;
          })}
        </div>
      </div>
    </section>
  );
}

function PaginationFooter({
  label,
  page,
  pageCount,
  total,
  onPageChange,
}: Readonly<{
  label: string;
  page: number;
  pageCount: number;
  total: number;
  onPageChange: (page: number) => void;
}>): React.JSX.Element | null {
  if (total === 0) return null;
  const first = (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
      <span>Showing <strong className="font-medium text-foreground">{first}–{last}</strong> of <strong className="font-medium text-foreground">{total}</strong> {label}</span>
      <nav aria-label={`${label} pagination`} className="flex items-center gap-1">
        <Button variant="ghost" size="sm" aria-label={`Previous ${label} page`} disabled={page === 1} onClick={(): void => { onPageChange(page - 1); }}>
          <ChevronLeft />
          Previous
        </Button>
        <span aria-current="page" className="min-w-16 text-center font-medium text-foreground">Page {page} of {pageCount}</span>
        <Button variant="ghost" size="sm" aria-label={`Next ${label} page`} disabled={page === pageCount} onClick={(): void => { onPageChange(page + 1); }}>
          Next
          <ChevronRight />
        </Button>
      </nav>
    </div>
  );
}

export function WorkspaceResources({
  workspaceId,
}: Readonly<{ workspaceId: string }>): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("resources");
  const [resources, setResources] = useState<Resource[]>([]);
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [dependencyGraph, setDependencyGraph] = useState<DependencyGraphState | null>(null);
  const [readme, setReadme] = useState<Readme | null>(null);
  const [search, setSearch] = useState("");
  const [pages, setPages] = useState<Readonly<Record<Tab, number>>>({ resources: 1, outputs: 1, graph: 1 });
  const [loading, setLoading] = useState(true);
  const [readmeLoading, setReadmeLoading] = useState(true);
  const [resourceError, setResourceError] = useState("");
  const [outputError, setOutputError] = useState("");
  const [readmeError, setReadmeError] = useState("");
  const [dependencyGraphError, setDependencyGraphError] = useState("");

  const load = useCallback(async (signal?: Readonly<AbortSignal>): Promise<void> => {
    setLoading(true);
    setReadmeLoading(true);
    setResourceError("");
    setOutputError("");
    setReadmeError("");
    setDependencyGraphError("");
    const stateResults = Promise.allSettled([
      fetchAllApiPages<Resource>(
        `/workspaces/${encodeURIComponent(workspaceId)}/resources?page[size]=100`,
        signal,
      ),
      fetchApi(
        `/workspaces/${encodeURIComponent(workspaceId)}/current-state-version-outputs`,
        signal === undefined ? {} : { signal },
      ),
      fetchApi(
        `/workspaces/${encodeURIComponent(workspaceId)}/dependency-graph`,
        signal === undefined ? {} : { signal },
      ),
    ]);
    const readmeResult = fetchApi(
      `/workspaces/${encodeURIComponent(workspaceId)}/readme`,
      signal === undefined ? {} : { signal },
    ).then(
      (value: unknown): Readonly<{ status: "fulfilled"; value: unknown }> => ({ status: "fulfilled", value }),
      (reason: unknown): Readonly<{ status: "rejected"; reason: unknown }> => ({ status: "rejected", reason }),
    );
    const [resourceResult, outputResult, dependencyGraphResult] = await stateResults;
    if (isAborted(signal)) return;
    if (resourceResult.status === "fulfilled") {
      setResources(resourceResult.value);
    } else {
      setResourceError(resourceResult.reason instanceof Error ? resourceResult.reason.message : "Could not load resources");
    }
    if (outputResult.status === "fulfilled") {
      const data = (outputResult.value as { data?: Output[] }).data;
      setOutputs(Array.isArray(data) ? data : []);
    } else if (outputResult.reason instanceof ApiError && outputResult.reason.status === 404) {
      setOutputs([]);
    } else {
      setOutputError(outputResult.reason instanceof Error ? outputResult.reason.message : "Could not load outputs");
    }
    if (dependencyGraphResult.status === "fulfilled") {
      const attributes = (dependencyGraphResult.value as { data?: { attributes?: { nodes?: unknown } } }).data?.attributes;
      const nodes = Array.isArray(attributes?.nodes)
        ? attributes.nodes.flatMap((value): DependencyGraphResource[] => {
            if (value === null || typeof value !== "object") return [];
            const node = value as { address?: unknown; dependencies?: unknown };
            if (typeof node.address !== "string" || !Array.isArray(node.dependencies)) return [];
            return [{ address: node.address, dependencies: node.dependencies.filter((dependency): dependency is string => typeof dependency === "string") }];
          })
        : [];
      setDependencyGraph({ nodes });
    } else if (dependencyGraphResult.reason instanceof ApiError && dependencyGraphResult.reason.status === 404) {
      setDependencyGraph(null);
    } else {
      setDependencyGraphError(dependencyGraphResult.reason instanceof Error ? dependencyGraphResult.reason.message : "Could not load dependency graph");
    }
    setLoading(false);

    const resolvedReadme = await readmeResult;
    if (isAborted(signal)) return;
    if (resolvedReadme.status === "fulfilled") {
      const data = (resolvedReadme.value as { data?: { attributes?: Readme } }).data?.attributes;
      setReadme(data?.content !== undefined ? data : null);
    } else if (resolvedReadme.reason instanceof ApiError && resolvedReadme.reason.status === 404) {
      setReadme(null);
    } else {
      setReadmeError(resolvedReadme.reason instanceof Error ? resolvedReadme.reason.message : "Could not load README.md");
    }
    setReadmeLoading(false);
  }, [workspaceId]);

  useEffect((): (() => void) => {
    const controller = new AbortController();
    void load(controller.signal);
    return (): void => { controller.abort(); };
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
    (): Output[] => outputs.filter((output): boolean => needle === "" || output.attributes.name.toLowerCase().includes(needle)),
    [needle, outputs],
  );
  const resourceDetails = useMemo((): Readonly<Record<string, ResourceDetails>> => {
    const details: Record<string, ResourceDetails> = {};
    resources.forEach((resource): void => {
      const entry: { provider?: string; "provider-type"?: string; module?: string; "updated-at"?: string } = {};
      if (resource.attributes.provider !== undefined) entry.provider = resource.attributes.provider;
      if (resource.attributes["provider-type"] !== undefined) entry["provider-type"] = resource.attributes["provider-type"];
      if (resource.attributes.module !== undefined) entry.module = resource.attributes.module;
      if (resource.attributes["updated-at"] !== undefined) entry["updated-at"] = resource.attributes["updated-at"];
      details[resource.attributes.address] = entry;
    });
    return details;
  }, [resources]);
  const activeTotal = tab === "resources" ? visibleResources.length : tab === "outputs" ? visibleOutputs.length : 0;
  const pageCount = Math.max(1, Math.ceil(activeTotal / PAGE_SIZE));
  const page = Math.min(pages[tab], pageCount);
  const resourcePage = visibleResources.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const outputPage = visibleOutputs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const activeError = tab === "resources" ? resourceError : tab === "outputs" ? outputError : dependencyGraphError;

  useEffect((): void => {
    if (pages[tab] > pageCount) setPages((current): Readonly<Record<Tab, number>> => ({ ...current, [tab]: pageCount }));
  }, [pageCount, pages, tab]);

  const setPage = (nextPage: number): void => {
    setPages((current): Readonly<Record<Tab, number>> => ({ ...current, [tab]: nextPage }));
  };

  return (
    <section aria-labelledby="workspace-state-heading" className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b px-5 py-4">
        <div>
          <h2 id="workspace-state-heading" className="font-semibold">Current state</h2>
          <p className="mt-1 text-sm text-muted-foreground">Browse resources, outputs, and the README from the most recent run.</p>
        </div>
        <div role="tablist" aria-label="Current state views" className="flex gap-1 rounded-lg bg-muted p-1">
          {(["resources", "outputs", "graph"] as const).map((value): React.JSX.Element => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={(): void => { setTab(value); setSearch(""); }}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tab === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value === "graph" ? "Dependency graph" : value}
            </button>
          ))}
        </div>
      </div>

      {tab !== "graph" && <div className="border-b p-4">
        <div className="relative max-w-md">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={`Search ${tab}`}
            className="pl-9"
            value={search}
            placeholder={`Search ${tab}`}
            onInput={(event): void => { setSearch(event.currentTarget.value); setPage(1); }}
          />
        </div>
      </div>}

      {loading ? (
        <div className="flex min-h-36 items-center justify-center"><Spinner aria-label="Loading current state" /></div>
      ) : activeError !== "" ? (
        <div role="alert" className="min-h-36 p-6 text-center">
          <p className="font-medium text-destructive">Could not load {tab}</p>
          <p className="mt-1 text-sm text-muted-foreground">{activeError}</p>
          <Button className="mt-3" size="sm" variant="outline" onClick={(): void => { void load(); }}>Try again</Button>
        </div>
      ) : tab === "resources" ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-64">Address</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Module</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resourcePage.map((resource): React.JSX.Element => (
                <TableRow key={resource.id}>
                  <TableCell className="font-mono text-xs">{resource.attributes.address}</TableCell>
                  <TableCell>{resource.attributes.provider ?? "—"}</TableCell>
                  <TableCell>{resource.attributes["provider-type"] ?? "—"}</TableCell>
                  <TableCell>{resource.attributes.module ?? "root"}</TableCell>
                  <TableCell><time dateTime={resource.attributes["updated-at"]}>{formatDate(resource.attributes["updated-at"])}</time></TableCell>
                </TableRow>
              ))}
              {resourcePage.length === 0 && <TableRow><TableCell colSpan={5} className="h-28 text-center text-muted-foreground">{resources.length === 0 ? "No resources are recorded in the current state." : "No resources match this search."}</TableCell></TableRow>}
            </TableBody>
          </Table>
          <PaginationFooter label="resources" page={page} pageCount={pageCount} total={visibleResources.length} onPageChange={setPage} />
        </>
      ) : tab === "outputs" ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Type</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {outputPage.map((output): React.JSX.Element => (
                <TableRow key={output.id}>
                  <TableCell className="font-mono text-xs">{output.attributes.name}</TableCell>
                  <TableCell className={cn("max-w-xl whitespace-normal break-words", output.attributes.sensitive === true ? "italic text-muted-foreground" : "font-mono text-xs")}>{outputValue(output)}</TableCell>
                  <TableCell>{output.attributes.type ?? "—"}</TableCell>
                </TableRow>
              ))}
              {outputPage.length === 0 && <TableRow><TableCell colSpan={3} className="h-28 text-center text-muted-foreground">{outputs.length === 0 ? "No outputs are recorded in the current state." : "No outputs match this search."}</TableCell></TableRow>}
            </TableBody>
          </Table>
          <PaginationFooter label="outputs" page={page} pageCount={pageCount} total={visibleOutputs.length} onPageChange={setPage} />
        </>
      ) : dependencyGraph === null ? (
        <div className="flex min-h-36 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          No dependency relationships are recorded in the current state.
        </div>
      ) : (
        <DependencyGraph resources={dependencyGraph.nodes} details={resourceDetails} />
      )}

      {readmeLoading && <div className="border-t px-5 py-4 text-xs text-muted-foreground">Checking for README.md…</div>}
        {!readmeLoading && readmeError !== "" && <p role="alert" className="border-t px-5 py-4 text-xs text-muted-foreground">README.md could not be loaded: {readmeError}</p>}
      {!readmeLoading && readme !== null && <ReadmePreview readme={readme} />}
    </section>
  );
}
