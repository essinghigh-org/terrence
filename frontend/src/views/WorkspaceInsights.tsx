import type { InsightResource } from "../lib/insights-api";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { PageHeader, PageShell } from "../components/PageHeader";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { record, resourceDocument, text, useInsightResource } from "../lib/insights-api";
import { InsightError, InsightLoading, InsightNotice, InsightTabs } from "../components/insights/InsightUI";
import { StateInsights } from "../components/insights/StateInsights";
import { DriftInsights } from "../components/insights/DriftInsights";
import { AccessInsights } from "../components/insights/AccessInsights";
import { ReviewTools } from "../components/insights/ReviewTools";
import { ReferenceCatalog } from "../components/insights/ReferenceCatalog";

const TABS = [
  { id: "states", label: "State & resource history" },
  { id: "drift", label: "Drift review" },
  { id: "access", label: "Access & input impact" },
  { id: "tools", label: "Review tools" },
  { id: "reference", label: "Blueprints & runbooks" },
] as const;

function WorkspaceInsightPanel({
  workspace,
  workspacePath,
  tab,
}: Readonly<{ workspace: InsightResource; workspacePath: string; tab: string }>): React.JSX.Element {
  const id = workspace.id;
  const attrs = workspace.attributes;
  const permissions = record(attrs["permissions"]);
  switch (tab) {
    case "states":
      return permissions["can-read-state-versions"] === true ? (
        <StateInsights workspaceId={id} workspacePath={workspacePath} />
      ) : (
        <InsightNotice>State comparisons and resource history require state-read permission.</InsightNotice>
      );
    case "drift":
      return (
        <DriftInsights
          workspaceId={id}
          workspacePath={workspacePath}
          permissions={{
            canManage: permissions["can-manage-run-tasks"] === true,
            canPlan: permissions["can-queue-run"] === true && attrs["execution-mode"] !== "local",
            locked: attrs["locked"] === true,
          }}
        />
      );
    case "access":
      return (
        <AccessInsights
          workspaceId={id}
          workspacePath={workspacePath}
          canReadVariables={permissions["can-read-variable"] === true}
        />
      );
    case "tools":
      return (
        <ReviewTools
          workspaceId={id}
          workspacePath={workspacePath}
          engine={text(attrs["iac-binary"], "terraform")}
          canPlan={permissions["can-queue-run"] === true}
        />
      );
    default:
      return <ReferenceCatalog workspaceId={id} canUpdate={permissions["can-update"] === true} />;
  }
}

export function WorkspaceInsights(): React.JSX.Element {
  const { orgName = "", workspaceName = "" } = useParams();
  const [params] = useSearchParams();
  const load = useInsightResource(
    `/organizations/${encodeURIComponent(orgName)}/workspaces/${encodeURIComponent(workspaceName)}`,
    resourceDocument,
  );
  const requested = params.get("tab");
  const tab = TABS.find((item): boolean => item.id === requested)?.id ?? "states";
  const orgPath = `/app/${encodeURIComponent(orgName)}`;
  const workspacePath = `${orgPath}/workspaces/${encodeURIComponent(workspaceName)}`;
  return (
    <PageShell variant="wide">
      <Breadcrumbs
        items={[{ label: orgName, to: orgPath }, { label: workspaceName, to: workspacePath }, { label: "Insights" }]}
      />
      <PageHeader
        eyebrow={workspaceName}
        title="Workspace insights"
        description="Review retained evidence, access and change impact without bypassing the normal run workflow."
      />
      <Link className="mb-4 inline-block text-sm text-primary hover:underline" to={workspacePath}>
        Back to workspace overview
      </Link>
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <>
          <InsightTabs tabs={TABS} current={tab} />
          <WorkspaceInsightPanel
            key={`${load.data.id}:${tab}`}
            workspace={load.data}
            workspacePath={workspacePath}
            tab={tab}
          />
        </>
      )}
    </PageShell>
  );
}
