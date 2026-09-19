import type { InsightTableRow } from "./InsightUI";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import {
  collectionDocument,
  text,
  useInsightAction,
  useInsightResource,
  type InsightRecord,
  type InsightResource,
} from "../../lib/insights-api";
import { ComparisonResult } from "./ComparisonResult";
import {
  InsightDate,
  InsightError,
  InsightLoading,
  InsightNotice,
  InsightPagination,
  InsightSection,
  InsightTable,
} from "./InsightUI";

function successfulBaseline(candidate: InsightResource, current: InsightResource): boolean {
  const before = Date.parse(text(candidate.attributes["created-at"], ""));
  const after = Date.parse(text(current.attributes["created-at"], ""));
  return (
    candidate.id !== current.id &&
    before < after &&
    ["applied", "planned_and_finished"].includes(text(candidate.attributes["status"])) &&
    (candidate.attributes["is-destroy"] === true) === (current.attributes["is-destroy"] === true)
  );
}

export function RunComparison({
  run,
  workspaceId,
  workspacePath,
}: Readonly<{ run: InsightResource; workspaceId: string; workspacePath: string }>): React.JSX.Element {
  const load = useInsightResource(
    `/workspaces/${encodeURIComponent(workspaceId)}/runs?page[size]=100`,
    collectionDocument,
  );
  const [choice, setChoice] = useState<string | null>(null);
  const candidates = (load.data?.data ?? []).filter((item): boolean => item.id !== run.id);
  const previous = candidates
    .filter((item): boolean => successfulBaseline(item, run))
    .sort(
      (a, b): number =>
        Date.parse(text(b.attributes["created-at"], "")) - Date.parse(text(a.attributes["created-at"], "")),
    )[0];
  const before = choice ?? previous?.id ?? "";
  const action = useInsightAction(`${run.id}:${before}`);
  const valid = before !== "" && candidates.some((item): boolean => item.id === before);
  return (
    <InsightSection
      title="Compare with a previous run"
      description="Defaults to the latest earlier successful run of the same kind among the 100 most recent runs. Both plans must still be retained."
    >
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <>
          {previous === undefined && (
            <InsightNotice>
              No earlier successful baseline was found in the recent run list. Select another retained run explicitly.
            </InsightNotice>
          )}
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event): void => {
              event.preventDefault();
              if (valid)
                void action.execute(`/runs/${encodeURIComponent(run.id)}/plan-comparisons`, {
                  "before-run-id": before,
                });
            }}
          >
            <label className="min-w-64 flex-1 space-y-1 text-sm">
              Baseline run
              <Select value={before} onValueChange={setChoice} disabled={action.busy}>
                <option value="">Select a run</option>
                {candidates.map(
                  (item): React.JSX.Element => (
                    <option key={item.id} value={item.id}>
                      {item.id} · {text(item.attributes["status"])} · {text(item.attributes["message"], "Run")}
                    </option>
                  ),
                )}
              </Select>
            </label>
            <Button type="submit" disabled={!valid || action.busy}>
              {action.busy ? "Comparing…" : "Compare plans"}
            </Button>
          </form>
          {valid && (
            <Link
              className="text-sm text-primary hover:underline"
              to={`${workspacePath}/runs/${encodeURIComponent(before)}`}
            >
              Open baseline run
            </Link>
          )}
        </>
      )}
      <InsightError error={action.error} />
      {action.result !== null && <ComparisonResult attributes={action.result.attributes} kind="plan" />}
    </InsightSection>
  );
}

function eventDescription(attrs: InsightRecord): string {
  const description = [attrs["status"], attrs["action"], attrs["branch"], attrs["commit-sha"]]
    .filter((value): value is string => typeof value === "string" && value !== "")
    .join(" · ");
  return description === "" ? "Persisted event" : description;
}

export function RunTimeline({ runId }: Readonly<{ runId: string }>): React.JSX.Element {
  const [page, setPage] = useState(1);
  const load = useInsightResource(
    `/runs/${encodeURIComponent(runId)}/timeline?page[number]=${page}&page[size]=25`,
    collectionDocument,
  );
  return (
    <InsightSection
      title="Correlated timeline"
      description="Persisted run transitions, configuration ingress and audit events in chronological order. This is bounded retained evidence, not a complete distributed trace."
    >
      <Button variant="outline" size="sm" onClick={load.reload} disabled={load.loading}>
        Refresh timeline
      </Button>
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <>
          <InsightTable
            headings={["When", "Source", "Event", "Actor"]}
            rows={load.data.data.map(
              (event): InsightTableRow => ({
                id: event.id,
                cells: [
                  <InsightDate key="date" value={event.attributes["occurred-at"]} />,
                  text(event.attributes["type"]),
                  eventDescription(event.attributes),
                  text(event.attributes["actor-id"], "System / not recorded"),
                ],
              }),
            )}
            empty="No persisted timeline events available."
          />
          <InsightPagination collection={load.data} page={page} setPage={setPage} />
        </>
      )}
    </InsightSection>
  );
}

export function Runbooks({ runId }: Readonly<{ runId?: string }>): React.JSX.Element {
  const endpoint =
    runId === undefined ? "/runbooks?q=troubleshooting&limit=8" : `/runs/${encodeURIComponent(runId)}/runbooks?limit=8`;
  const load = useInsightResource(endpoint, collectionDocument);
  return (
    <InsightSection
      title="Operational runbooks"
      description="Reference documentation. These suggestions do not diagnose the run or prove a root cause."
    >
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <div className="grid gap-3 md:grid-cols-2">
          {load.data.data.map(
            (book): React.JSX.Element => (
              <Link
                key={book.id}
                to={`/app/docs/${encodeURIComponent(book.id)}`}
                className="rounded-md border border-border p-4 hover:bg-muted/40"
              >
                <p className="font-medium text-primary">{text(book.attributes["title"])}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {text(book.attributes["description"], "Read documentation")}
                </p>
              </Link>
            ),
          )}
          {load.data.data.length === 0 && <p className="text-sm text-muted-foreground">No matching runbooks.</p>}
        </div>
      )}
    </InsightSection>
  );
}
