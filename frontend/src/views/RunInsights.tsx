import { Link, useParams, useSearchParams } from "react-router-dom";
import { PageHeader, PageShell } from "../components/PageHeader";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { InsightError, InsightLoading, InsightNotice, InsightTabs } from "../components/insights/InsightUI";
import { RunComparison, RunTimeline, Runbooks } from "../components/insights/RunInsightPanels";
import { record, resourceDocument, text, useInsightResource } from "../lib/insights-api";

const TABS = [
  { id: "compare", label: "Compare plans" },
  { id: "timeline", label: "Timeline" },
  { id: "runbooks", label: "Runbooks" },
] as const;

export function RunInsights(): React.JSX.Element {
  const { orgName = "", workspaceName = "", runId = "" } = useParams();
  const [params] = useSearchParams();
  const load = useInsightResource(runId === "" ? null : `/runs/${encodeURIComponent(runId)}`, resourceDocument);
  const tab = TABS.find((item): boolean => item.id === params.get("tab"))?.id ?? "compare";
  const workspaceId = text(record(record(load.data?.relationships?.["workspace"])["data"])["id"], "");
  const orgPath = `/app/${encodeURIComponent(orgName)}`;
  const workspacePath = `${orgPath}/workspaces/${encodeURIComponent(workspaceName)}`;
  return (
    <PageShell variant="wide">
      <Breadcrumbs
        items={[
          { label: orgName, to: orgPath },
          { label: workspaceName, to: workspacePath },
          { label: runId, to: `${workspacePath}/runs/${encodeURIComponent(runId)}` },
          { label: "Insights" },
        ]}
      />
      <PageHeader
        eyebrow="Run review"
        title="Run insights"
        description={`Compare retained evidence and investigate the history of ${runId}.`}
      />
      <Link
        to={`${workspacePath}/runs/${encodeURIComponent(runId)}`}
        className="mb-4 inline-block text-sm text-primary hover:underline"
      >
        Back to plan and apply
      </Link>
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <>
          <InsightTabs tabs={TABS} current={tab} />
          {workspaceId === "" ? (
            <InsightNotice>The run response did not include its workspace. Insights are unavailable.</InsightNotice>
          ) : (
            <>
              {tab === "compare" && (
                <RunComparison key={runId} run={load.data} workspaceId={workspaceId} workspacePath={workspacePath} />
              )}
              {tab === "timeline" && <RunTimeline key={runId} runId={runId} />}
              {tab === "runbooks" && <Runbooks key={runId} runId={runId} />}
            </>
          )}
        </>
      )}
    </PageShell>
  );
}
