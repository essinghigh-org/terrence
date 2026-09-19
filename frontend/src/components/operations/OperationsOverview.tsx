import type { InsightRecord } from "../../lib/insights-api";
import type { InsightTableRow } from "../insights/InsightUI";
import { Link } from "react-router-dom";
import { Button } from "../ui/button";
import {
  objectDocument,
  record,
  records,
  resourceDocument,
  numberValue,
  text,
  useInsightResource,
} from "../../lib/insights-api";
import {
  InsightDate,
  InsightError,
  InsightLoading,
  InsightNotice,
  InsightSection,
  InsightStatus,
  InsightTable,
  JsonDetails,
} from "../insights/InsightUI";

function enabledLabel(value: unknown): string {
  return value === true ? "Enabled" : value === false ? "Disabled" : "Unknown";
}

function sandboxLabel(sandbox: InsightRecord): string {
  if (sandbox["enabled"] === false) return "disabled";
  if (sandbox["enabled"] !== true) return "unknown";
  return sandbox["available"] === true ? "available" : sandbox["available"] === false ? "unavailable" : "unknown";
}

function leaseStateLabel(value: unknown): string {
  if (value === true) return "Active";
  if (value === false) return "Expired";
  return "Unknown";
}

function RuntimeSummary(): React.JSX.Element {
  const load = useInsightResource("/admin/system-info", objectDocument);
  const worker = record(load.data?.["worker"]);
  const storage = record(load.data?.["storage"]);
  const sandbox = record(load.data?.["sandbox"]);
  const free = numberValue(storage["free-bytes"]);
  return (
    <InsightSection
      title="Runtime and execution"
      description="Current control-plane observations; unknown values are never shown as healthy."
    >
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Worker" value={enabledLabel(worker["enabled"])} />
            <Metric label="Queued runs" value={numberValue(worker["runs-queued"])?.toLocaleString() ?? "Unknown"} />
            <Metric
              label="Executing / capacity"
              value={`${numberValue(worker["local-runs-executing"]) ?? "?"} / ${numberValue(worker["run-concurrency-limit"]) ?? "?"}`}
            />
            <Metric label="Free storage" value={free === null ? "Unknown" : `${(free / 1024 ** 3).toFixed(1)} GiB`} />
          </div>
          <p className="text-sm text-muted-foreground">
            Version {text(load.data["version"])} · Sandbox {sandboxLabel(sandbox)}
          </p>
          {sandbox["enabled"] === true && sandbox["available"] !== true && (
            <InsightNotice>{text(sandbox["reason"], "Sandbox readiness could not be confirmed.")}</InsightNotice>
          )}
          <Link className="text-sm text-primary hover:underline" to="/app/admin/runs">
            Inspect the run queue
          </Link>
          <Button size="sm" variant="outline" onClick={load.reload}>
            Refresh runtime
          </Button>
        </>
      )}
    </InsightSection>
  );
}

function Metric({ label, value }: Readonly<{ label: string; value: string }>): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 text-xl font-semibold">{value}</p>
    </div>
  );
}

function NodeSummary(): React.JSX.Element {
  const load = useInsightResource("/admin/operations-center", resourceDocument);
  const attrs = load.data?.attributes;
  const backup = record(attrs?.["backup"]);
  const coordinator = record(attrs?.["coordinator"]);
  const executionLeases = record(attrs?.["execution-leases"]);
  return (
    <InsightSection
      title="Control plane and recovery"
      description="Control-plane membership, coordinator ownership and recovery evidence."
    >
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {attrs !== undefined && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
            <Metric label="HA mode" value={enabledLabel(attrs["ha-enabled"])} />
            <Metric label="Coordinator" value={text(coordinator["owner-node-id"], "None")} />
            <Metric
              label="Coordinator epoch"
              value={numberValue(coordinator["epoch"])?.toLocaleString() ?? "Unknown"}
            />
            <Metric label="Lease" value={leaseStateLabel(coordinator["active"])} />
            <Metric
              label="Active executions"
              value={numberValue(executionLeases["active"])?.toLocaleString() ?? "Unknown"}
            />
            <Metric
              label="Expired execution leases"
              value={numberValue(executionLeases["expired"])?.toLocaleString() ?? "Unknown"}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>Restore rehearsal:</span>
            <InsightStatus value={backup["status"]} />
            <span>
              Last verified: <InsightDate value={backup["last-verified-restore-at"]} />
            </span>
            <Link className="text-primary hover:underline" to="?tab=backups">
              Review backup evidence
            </Link>
          </div>
          <InsightTable
            headings={["Node", "Role", "Epoch", "Version", "Recorded status", "Heartbeat"]}
            empty="No node heartbeats recorded. Readiness is unknown."
            rows={records(attrs["nodes"]).map(
              (node): InsightTableRow => ({
                id: text(node["id"]),
                cells: [
                  text(node["id"]),
                  text(node["role"], "standalone"),
                  numberValue(node["coordinator-epoch"])?.toLocaleString() ?? "—",
                  text(node["version"]),
                  <InsightStatus key="status" value={node["stale"] === true ? "stale" : node["status"]} />,
                  <InsightDate key="date" value={node["last-heartbeat-at"]} />,
                ],
              }),
            )}
          />
          <p className="text-xs text-muted-foreground">
            Snapshot: <InsightDate value={attrs["checked-at"]} /> · Local node: {text(attrs["local-node-id"])} ·
            Topology: {text(attrs["supported-topology"])}
            {coordinator["expires-at"] !== undefined && (
              <>
                {" "}
                · Lease expires: <InsightDate value={coordinator["expires-at"]} />
              </>
            )}
          </p>
          <Button size="sm" variant="outline" onClick={load.reload}>
            Refresh recovery and nodes
          </Button>
        </>
      )}
    </InsightSection>
  );
}

function MaintenanceSummary(): React.JSX.Element {
  const load = useInsightResource("/admin/maintenance-windows/preview", resourceDocument);
  return (
    <InsightSection
      title="Maintenance schedule"
      description="Configured windows block applies, not plans. This preview does not change the schedule."
    >
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <>
          <p className="text-sm">
            Scheduled windows: {load.data.attributes["enabled"] === true ? "Enabled" : "Disabled"}
          </p>
          <JsonDetails value={load.data.attributes} label="View schedule preview" />
        </>
      )}
      <div className="flex flex-wrap gap-4 text-sm">
        <Link to="/app/admin/maintenance" className="text-primary hover:underline">
          Edit maintenance windows
        </Link>
        <Link to="/app/docs/operations" className="text-primary hover:underline">
          Operations guide
        </Link>
        <Link to="/app/admin/database" className="text-primary hover:underline">
          Database migration
        </Link>
        <Link to="/app/admin/audit" className="text-primary hover:underline">
          Audit logs
        </Link>
      </div>
    </InsightSection>
  );
}

export function OperationsOverview(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <RuntimeSummary />
      <NodeSummary />
      <MaintenanceSummary />
    </div>
  );
}
