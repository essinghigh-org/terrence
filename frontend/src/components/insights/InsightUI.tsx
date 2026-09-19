import { useId, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Spinner } from "../ui/spinner";
import { formatDateTime } from "../../lib/utils";
import { text, type InsightCollection } from "../../lib/insights-api";

export type InsightTableRow = Readonly<{ id: string; cells: readonly ReactNode[] }>;

export function InsightSection({
  title,
  description,
  children,
}: Readonly<{ title: string; description?: string; children: ReactNode }>): React.JSX.Element {
  const id = useId();
  return (
    <Card aria-labelledby={id}>
      <CardHeader variant="section">
        <CardTitle id={id}>{title}</CardTitle>
        {description !== undefined && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4 pt-4">{children}</CardContent>
    </Card>
  );
}

export function InsightNotice({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
  return <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">{children}</p>;
}

export function InsightError({
  error,
  retry,
}: Readonly<{ error: string; retry?: () => void }>): React.JSX.Element | null {
  if (error === "") return null;
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
      <p>{error}</p>
      {retry !== undefined && (
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function InsightLoading(): React.JSX.Element {
  return (
    <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Spinner className="size-4" />
      Loading…
    </p>
  );
}

export function InsightTabs({
  tabs,
  current,
  queryKey = "tab",
}: Readonly<{
  tabs: readonly Readonly<{ id: string; label: string }>[];
  current: string;
  queryKey?: string;
}>): React.JSX.Element {
  const [params] = useSearchParams();
  return (
    <nav aria-label="Section navigation" className="mb-6 flex flex-wrap gap-1 border-b border-border pb-2">
      {tabs.map((tab): React.JSX.Element => {
        const next = new URLSearchParams(params);
        next.set(queryKey, tab.id);
        return (
          <Link
            key={tab.id}
            to={`?${next.toString()}`}
            aria-current={current === tab.id ? "page" : undefined}
            className={`rounded-md px-3 py-2 text-sm font-medium ${current === tab.id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function InsightTable({
  headings,
  rows,
  empty = "No records found.",
}: Readonly<{
  headings: readonly string[];
  rows: readonly Readonly<{ id: string; cells: readonly ReactNode[] }>[];
  empty?: string;
}>): React.JSX.Element {
  if (rows.length === 0) return <p className="py-6 text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            {headings.map(
              (heading): React.JSX.Element => (
                <th
                  key={heading}
                  scope="col"
                  className="border-b border-border px-3 py-2 font-medium text-muted-foreground"
                >
                  {heading}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map(
            (row): React.JSX.Element => (
              <tr key={row.id}>
                {row.cells.map(
                  (cell, index): React.JSX.Element => (
                    <td
                      key={headings[index] ?? index}
                      className="max-w-xl break-words border-b border-border/60 px-3 py-3 align-top"
                    >
                      {cell}
                    </td>
                  ),
                )}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

export function InsightPagination({
  collection,
  page,
  setPage,
  busy = false,
}: Readonly<{
  collection: InsightCollection;
  page: number;
  setPage: (page: number) => void;
  busy?: boolean;
}>): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>
        Page {page} of {collection.pages}
        {collection.total === null ? "" : ` · ${collection.total} records`}
      </span>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || page <= 1}
          onClick={(): void => {
            setPage(page - 1);
          }}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || page >= collection.pages}
          onClick={(): void => {
            setPage(page + 1);
          }}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

export function InsightDate({ value }: Readonly<{ value: unknown }>): React.JSX.Element {
  const candidate = typeof value === "number" ? value : Date.parse(text(value, ""));
  const date = Number.isFinite(candidate) && Math.abs(candidate) <= 8.64e15 ? new Date(candidate).toISOString() : "";
  return <span>{date !== "" && Number.isFinite(Date.parse(date)) ? formatDateTime(date) : "Not recorded"}</span>;
}

export function InsightStatus({ value }: Readonly<{ value: unknown }>): React.JSX.Element {
  const status = text(value, "unknown");
  const good = ["current", "finished", "done", "completed", "pass", "ok", "applied", "active"].includes(
    status.toLowerCase(),
  );
  const bad = ["failed", "errored", "error", "overdue", "fail", "blocked"].includes(status.toLowerCase());
  const style = good
    ? "bg-success/10 text-success"
    : bad
      ? "bg-destructive/10 text-destructive"
      : "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${style}`}>{status.replace(/_/g, " ")}</span>
  );
}

export function JsonDetails({
  value,
  label = "View redacted evidence",
}: Readonly<{ value: unknown; label?: string }>): React.JSX.Element {
  return (
    <details className="rounded-md border border-border p-3 text-sm">
      <summary className="cursor-pointer font-medium">{label}</summary>
      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}
