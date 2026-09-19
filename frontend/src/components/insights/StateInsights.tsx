import type { InsightResource, InsightCollection } from "../../lib/insights-api";
import type { InsightTableRow } from "./InsightUI";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { collectionDocument, numberValue, text, useInsightAction, useInsightResource } from "../../lib/insights-api";
import { ComparisonResult } from "./ComparisonResult";
import { InsightDate, InsightError, InsightLoading, InsightNotice, InsightSection, InsightTable } from "./InsightUI";

function selectStates(
  collection: InsightCollection | null,
  beforeChoice: string | null,
  afterChoice: string | null,
): Readonly<{ sorted: readonly InsightResource[]; before: string; after: string; valid: boolean }> {
  const sorted = [...(collection?.data ?? [])].sort(
    (a, b): number => (numberValue(b.attributes["serial"]) ?? 0) - (numberValue(a.attributes["serial"]) ?? 0),
  );
  const after = afterChoice ?? sorted[0]?.id ?? "";
  const before = beforeChoice ?? sorted[1]?.id ?? "";
  const valid =
    before !== "" &&
    after !== "" &&
    before !== after &&
    sorted.some((item): boolean => item.id === before) &&
    sorted.some((item): boolean => item.id === after);
  return { sorted, before, after, valid };
}

function StateComparison({ workspaceId }: Readonly<{ workspaceId: string }>): React.JSX.Element {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  const versions = useInsightResource(`${base}/state-versions?page[size]=100`, collectionDocument);
  const [beforeChoice, setBeforeChoice] = useState<string | null>(null);
  const [afterChoice, setAfterChoice] = useState<string | null>(null);
  const { sorted, before, after, valid } = selectStates(versions.data, beforeChoice, afterChoice);
  const action = useInsightAction(`${workspaceId}:${before}:${after}`);
  return (
    <InsightSection
      title="Compare state versions"
      description="Choose two of the most recent 100 retained versions. Comparisons never roll back or promote state."
    >
      <InsightError error={versions.error} retry={versions.reload} />
      {versions.loading && <InsightLoading />}
      {versions.data !== null && (
        <>
          {sorted.length < 2 && <InsightNotice>At least two retained state versions are required.</InsightNotice>}
          <form
            className="grid items-end gap-3 md:grid-cols-[1fr_1fr_auto]"
            onSubmit={(event): void => {
              event.preventDefault();
              if (valid)
                void action.execute(`${base}/state-comparisons`, {
                  "before-state-version-id": before,
                  "after-state-version-id": after,
                });
            }}
          >
            <label className="space-y-1 text-sm">
              Before state
              <Select value={before} onValueChange={setBeforeChoice} disabled={action.busy}>
                <option value="">Select baseline</option>
                {sorted.map(
                  (version): React.JSX.Element => (
                    <option key={version.id} value={version.id}>
                      #{numberValue(version.attributes["serial"]) ?? "?"} · {version.id}
                    </option>
                  ),
                )}
              </Select>
            </label>
            <label className="space-y-1 text-sm">
              After state
              <Select value={after} onValueChange={setAfterChoice} disabled={action.busy}>
                <option value="">Select target</option>
                {sorted.map(
                  (version): React.JSX.Element => (
                    <option key={version.id} value={version.id}>
                      #{numberValue(version.attributes["serial"]) ?? "?"} · {version.id}
                    </option>
                  ),
                )}
              </Select>
            </label>
            <Button type="submit" disabled={!valid || action.busy}>
              {action.busy ? "Comparing…" : "Compare states"}
            </Button>
          </form>
        </>
      )}
      <InsightError error={action.error} />
      {action.result !== null && <ComparisonResult attributes={action.result.attributes} kind="state" />}
    </InsightSection>
  );
}

function InventoryHistory({
  workspaceId,
  workspacePath,
}: Readonly<{ workspaceId: string; workspacePath: string }>): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const load = useInsightResource(
    `/workspaces/${encodeURIComponent(workspaceId)}/inventory-history?q=${encodeURIComponent(query)}`,
    collectionDocument,
  );
  const items = load.data?.data ?? [];
  const pageSize = 50;
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  return (
    <InsightSection
      title="Resource history"
      description="Observations derived from bounded retained state history, not a live provider inventory. Deleted or expired versions cannot contribute evidence."
    >
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event): void => {
          event.preventDefault();
          setPage(1);
          setQuery(search.trim());
        }}
      >
        <label className="min-w-64 flex-1 space-y-1 text-sm">
          Filter resource history
          <Input
            value={search}
            onInput={(event): void => {
              setSearch(event.currentTarget.value);
            }}
            placeholder="Resource address, provider or ID"
          />
        </label>
        <Button type="submit" variant="outline">
          Search history
        </Button>
      </form>
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <>
          <InsightTable
            headings={["Resource", "Provider", "State serial", "Observed", "Run"]}
            rows={items.slice((page - 1) * pageSize, page * pageSize).map(
              (item, index): InsightTableRow => ({
                id: `${item.id}-${index}`,
                cells: [
                  <code key="address" className="text-xs">
                    {text(item.attributes["address"])}
                  </code>,
                  text(item.attributes["provider"]),
                  String(numberValue(item.attributes["serial"]) ?? "?"),
                  <InsightDate key="date" value={item.attributes["observed-at"]} />,
                  typeof item.attributes["run-id"] === "string" ? (
                    <Link
                      key="run"
                      className="text-primary hover:underline"
                      to={`${workspacePath}/runs/${encodeURIComponent(item.attributes["run-id"])}`}
                    >
                      View run
                    </Link>
                  ) : (
                    "Not recorded"
                  ),
                ],
              }),
            )}
            empty="No matching observations in retained state history."
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {items.length} retained observations · page {page} of {pages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={(): void => {
                  setPage(page - 1);
                }}
              >
                Previous observations
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pages}
                onClick={(): void => {
                  setPage(page + 1);
                }}
              >
                Next observations
              </Button>
            </div>
          </div>
        </>
      )}
    </InsightSection>
  );
}

export function StateInsights({
  workspaceId,
  workspacePath,
}: Readonly<{ workspaceId: string; workspacePath: string }>): React.JSX.Element {
  return (
    <div className="space-y-6">
      <StateComparison workspaceId={workspaceId} />
      <InventoryHistory workspaceId={workspaceId} workspacePath={workspacePath} />
    </div>
  );
}
