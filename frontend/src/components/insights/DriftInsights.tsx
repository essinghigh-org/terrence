import type { InsightTableRow } from "./InsightUI";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ConfirmDialog } from "../ui/confirm-dialog";
import {
  collectionDocument,
  text,
  useInsightAction,
  useInsightResource,
  type InsightResource,
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
} from "./InsightUI";

type DriftPermissions = Readonly<{ canManage: boolean; canPlan: boolean; locked: boolean }>;

function Assessments({
  workspaceId,
  canManage,
  onRecorded,
}: Readonly<{ workspaceId: string; canManage: boolean; onRecorded: () => void }>): React.JSX.Element {
  const load = useInsightResource(
    `/workspaces/${encodeURIComponent(workspaceId)}/assessment-results`,
    collectionDocument,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const action = useInsightAction(workspaceId);
  const recordIncident = async (): Promise<void> => {
    if (selected === null) return;
    const result = await action.execute(`/assessment-results/${encodeURIComponent(selected)}/drift-incident`);
    if (result !== null) {
      setSelected(null);
      onRecorded();
    }
  };
  return (
    <InsightSection
      title="Recent health assessments"
      description="Latest 20 retained assessments. Only completed assessments with observed drift can be recorded as an incident here."
    >
      <InsightError error={load.error} retry={load.reload} />
      <InsightError error={action.error} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <InsightTable
          headings={["Assessment", "Status", "Drift", "Completed", "Actions"]}
          empty="No assessments recorded. Enable health assessments in workspace settings."
          rows={load.data.data.map(
            (item): InsightTableRow => ({
              id: item.id,
              cells: [
                <code key="id" className="text-xs">
                  {item.id}
                </code>,
                <InsightStatus key="status" value={item.attributes["status"]} />,
                item.attributes["drifted"] === true
                  ? "Observed"
                  : item.attributes["drifted"] === false
                    ? "Not observed"
                    : "Unknown",
                <InsightDate key="date" value={item.attributes["completed-at"]} />,
                canManage && item.attributes["status"] === "completed" && item.attributes["drifted"] === true ? (
                  <Button
                    key="record"
                    size="sm"
                    variant="outline"
                    disabled={action.busy}
                    onClick={(): void => {
                      setSelected(item.id);
                    }}
                  >
                    Record incident
                  </Button>
                ) : (
                  "—"
                ),
              ],
            }),
          )}
        />
      )}
      {action.result !== null && (
        <p role="status" className="text-sm">
          Incident recorded or updated from this assessment.
        </p>
      )}
      <ConfirmDialog
        open={selected !== null}
        onOpenChange={(open): void => {
          if (!open && !action.busy) setSelected(null);
        }}
        title="Record drift incident?"
        description={`Assessment ${selected ?? ""} will be attached to a reviewable incident. No run is queued and no resources are changed.`}
        confirmText="Record incident"
        confirmVariant="default"
        loading={action.busy}
        onConfirm={recordIncident}
      />
    </InsightSection>
  );
}

const INCIDENT_CONFIRMATION = {
  remediate: {
    title: "Queue reviewed remediation?",
    description:
      "A normal plan-and-apply run will be created with auto-apply disabled. Review its plan and policies before an authorized person approves apply. The incident remains open.",
  },
  resolve: {
    title: "Accept an explicit exception?",
    description:
      "This records an acknowledged exception and your note. It does not prove drift has been fixed or that cloud resources are compliant.",
  },
  snooze: {
    title: "Snooze incident for 24 hours?",
    description:
      "This snoozes only the incident record; it does not disable assessment execution or notification delivery.",
  },
} as const;

function incidentUpdateDisabled(
  busy: boolean,
  status: string,
  comment: string,
  assignee: string,
  initialAssignee: string,
): boolean {
  if (busy || status === "resolved") return true;
  if (comment.trim() !== "") return false;
  const nextAssignee = assignee.trim();
  return nextAssignee === "" || nextAssignee === initialAssignee;
}

function DriftIncident({
  incident,
  permissions,
  workspacePath,
  onChanged,
}: Readonly<{
  incident: InsightResource;
  permissions: DriftPermissions;
  workspacePath: string;
  onChanged: () => void;
}>): React.JSX.Element {
  const [comment, setComment] = useState("");
  const initialAssignee = text(incident.attributes["assignee"], "");
  const [assignee, setAssignee] = useState(initialAssignee);
  const [confirm, setConfirm] = useState<"remediate" | "resolve" | "snooze" | null>(null);
  const action = useInsightAction(incident.id);
  const status = text(incident.attributes["status"]);
  const runId = text(incident.attributes["remediation-run-id"], "");
  const base = `/drift-incidents/${encodeURIComponent(incident.id)}`;
  const submit = async (): Promise<void> => {
    if (confirm === null) return;
    const attrs =
      confirm === "resolve"
        ? {
            status: "resolved",
            "resolution-classification": "acknowledged-exception",
            "acknowledged-exception": true,
            comment: comment.trim(),
          }
        : {
            status: "snoozed",
            "snooze-until": new Date(Date.now() + 86_400_000).toISOString(),
            comment: comment.trim(),
          };
    const result =
      confirm === "remediate"
        ? await action.execute(`${base}/remediation`)
        : await action.execute(base, attrs, "PATCH");
    if (result !== null) {
      setConfirm(null);
      onChanged();
    }
  };
  const saveComment = async (): Promise<void> => {
    const result = await action.execute(
      base,
      { comment: comment.trim(), ...(assignee.trim() === "" ? {} : { assignee: assignee.trim() }) },
      "PATCH",
    );
    if (result !== null) {
      setComment("");
      onChanged();
    }
  };
  return (
    <InsightSection
      title={`Incident ${incident.id}`}
      description={`Latest evidence: ${text(incident.attributes["latest-assessment-id"])}`}
    >
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <InsightStatus value={status} />
        <span>
          Observed <InsightDate value={incident.attributes["observed-at"]} />
        </span>
        <span>Assigned: {text(incident.attributes["assignee"], "Unassigned")}</span>
      </div>
      {runId !== "" && (
        <Link
          className="inline-block text-sm text-primary hover:underline"
          to={`${workspacePath}/runs/${encodeURIComponent(runId)}`}
        >
          Review remediation run {runId}
        </Link>
      )}
      <InsightError error={action.error} />
      {permissions.canManage && (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm">
              Assignee
              <Input
                value={assignee}
                onInput={(event): void => {
                  setAssignee(event.currentTarget.value);
                }}
                disabled={action.busy}
              />
            </label>
            <label className="space-y-1 text-sm">
              Incident note
              <Textarea
                value={comment}
                onInput={(event): void => {
                  setComment(event.currentTarget.value);
                }}
                disabled={action.busy}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={incidentUpdateDisabled(action.busy, status, comment, assignee, initialAssignee)}
              onClick={(): void => {
                void saveComment();
              }}
            >
              Save note and assignee
            </Button>
            {status !== "resolved" && (
              <>
                <Button
                  variant="outline"
                  disabled={action.busy}
                  onClick={(): void => {
                    setConfirm("snooze");
                  }}
                >
                  Snooze 24 hours
                </Button>
                <Button
                  variant="outline"
                  disabled={action.busy || comment.trim() === ""}
                  onClick={(): void => {
                    setConfirm("resolve");
                  }}
                >
                  Acknowledge exception
                </Button>
                {permissions.canPlan && (
                  <Button
                    disabled={action.busy || permissions.locked}
                    onClick={(): void => {
                      setConfirm("remediate");
                    }}
                  >
                    Plan remediation
                  </Button>
                )}
              </>
            )}
            {status === "resolved" && (
              <Button
                variant="outline"
                disabled={action.busy}
                onClick={(): void => {
                  void action
                    .execute(base, { status: "open", comment: comment.trim() }, "PATCH")
                    .then((result): void => {
                      if (result !== null) onChanged();
                    });
                }}
              >
                Reopen incident
              </Button>
            )}
          </div>
          {permissions.locked && (
            <InsightNotice>
              The workspace is locked. Unlock it through the normal workspace controls before requesting a remediation
              run.
            </InsightNotice>
          )}
        </>
      )}
      <JsonDetails
        value={{
          history: incident.attributes["history"],
          comments: incident.attributes["comments"],
          "snooze-until": incident.attributes["snooze-until"],
          classification: incident.attributes["resolution-classification"],
        }}
        label="Incident history and resolution evidence"
      />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open): void => {
          if (!open && !action.busy) setConfirm(null);
        }}
        title={INCIDENT_CONFIRMATION[confirm ?? "snooze"].title}
        description={INCIDENT_CONFIRMATION[confirm ?? "snooze"].description}
        confirmText={confirm === "remediate" ? "Queue review run" : "Confirm"}
        confirmVariant="default"
        requireCheckbox={
          confirm === "resolve" ? "I accept this exception; no successful remediation is being claimed." : undefined
        }
        loading={action.busy}
        onConfirm={submit}
      />
    </InsightSection>
  );
}

export function DriftInsights({
  workspaceId,
  workspacePath,
  permissions,
}: Readonly<{ workspaceId: string; workspacePath: string; permissions: DriftPermissions }>): React.JSX.Element {
  const load = useInsightResource(`/workspaces/${encodeURIComponent(workspaceId)}/drift-incidents`, collectionDocument);
  return (
    <div className="space-y-6">
      <Assessments workspaceId={workspaceId} canManage={permissions.canManage} onRecorded={load.reload} />
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Drift incidents</h2>
        <Button size="sm" variant="outline" onClick={load.reload} disabled={load.loading}>
          Refresh incidents
        </Button>
      </div>
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <>
          {load.data.data.length === 0 && (
            <InsightNotice>
              No retained drift incidents. An empty incident list is not proof that all resources match configuration.
            </InsightNotice>
          )}
          {load.data.data.map(
            (incident): React.JSX.Element => (
              <DriftIncident
                key={`${incident.id}:${text(incident.attributes["updated-at"])}`}
                incident={incident}
                permissions={permissions}
                workspacePath={workspacePath}
                onChanged={load.reload}
              />
            ),
          )}
        </>
      )}
    </div>
  );
}
