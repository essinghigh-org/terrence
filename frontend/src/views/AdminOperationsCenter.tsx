import { useOutletContext, useSearchParams } from "react-router-dom";
import { PageHeader, PageShell } from "../components/PageHeader";
import type { LayoutOutletContext } from "../components/Layout";
import { InsightLoading, InsightNotice, InsightTabs } from "../components/insights/InsightUI";
import { OperationsOverview } from "../components/operations/OperationsOverview";
import { OperationsBackups } from "../components/operations/OperationsBackups";
import { OperationsWebhooks } from "../components/operations/OperationsWebhooks";
import { OperationsSupport } from "../components/operations/OperationsSupport";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "backups", label: "Backup verification" },
  { id: "webhooks", label: "Webhook deliveries" },
  { id: "support", label: "Support bundles" },
] as const;

export function AdminOperationsCenter(): React.JSX.Element {
  const context = useOutletContext<LayoutOutletContext | undefined>();
  const [params] = useSearchParams();
  const requested = params.get("tab");
  const tab = TABS.find((item): boolean => item.id === requested)?.id ?? "overview";
  if (context?.accountLoaded !== true)
    return (
      <PageShell>
        <InsightLoading />
      </PageShell>
    );
  if (!context.siteAdmin)
    return (
      <PageShell>
        <InsightNotice>Site-administrator access is required.</InsightNotice>
      </PageShell>
    );
  return (
    <PageShell variant="wide">
      <PageHeader
        eyebrow="Site administration"
        title="Operations center"
        description="Inspect execution health, verify recovery evidence and investigate integration failures."
      />
      <InsightTabs tabs={TABS} current={tab} />
      {tab === "overview" && <OperationsOverview />}
      {tab === "backups" && <OperationsBackups />}
      {tab === "webhooks" && <OperationsWebhooks />}
      {tab === "support" && <OperationsSupport />}
    </PageShell>
  );
}
