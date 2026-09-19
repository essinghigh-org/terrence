import type { InsightTableRow } from "./InsightUI";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Select } from "../ui/select";
import {
  collectionDocument,
  record,
  records,
  resourceDocument,
  text,
  useInsightResource,
} from "../../lib/insights-api";
import {
  InsightError,
  InsightLoading,
  InsightNotice,
  InsightSection,
  InsightStatus,
  InsightTable,
  JsonDetails,
} from "./InsightUI";

function CurrentAccess({ workspaceId }: Readonly<{ workspaceId: string }>): React.JSX.Element {
  const load = useInsightResource(`/workspaces/${encodeURIComponent(workspaceId)}/access-review`, resourceDocument);
  const permissions = record(load.data?.attributes["permissions"]);
  return (
    <InsightSection
      title="Your effective access"
      description="Current request-time permissions and the grants contributing to your access. This is not an organization-wide user directory or a revocation simulator."
    >
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <>
          <div className="flex flex-wrap gap-2">
            {Object.entries(permissions).map(
              ([name, value]): React.JSX.Element => (
                <span key={name} className="rounded-md border border-border px-3 py-2 text-xs">
                  {name}: <strong>{value === true ? "Allowed" : value === false ? "Not granted" : "Unknown"}</strong>
                </span>
              ),
            )}
          </div>
          <InsightTable
            headings={["Source", "Grant", "Role / access"]}
            empty="No ordinary membership or team grants recorded for this principal."
            rows={records(load.data.attributes["grants"]).map(
              (grant, index): InsightTableRow => ({
                id: `${text(grant["id"])}-${index}`,
                cells: [
                  text(grant["source"]),
                  text(grant["name"] ?? grant["id"]),
                  text(grant["role"] ?? grant["access"], "See grant details"),
                ],
              }),
            )}
          />
          <InsightNotice>
            {text(
              load.data.attributes["pre-issued-capability-note"],
              "Existing signed capabilities follow their own expiry; this view does not revoke them.",
            )}
          </InsightNotice>
          <JsonDetails value={load.data.attributes["grants"]} label="Grant details" />
        </>
      )}
    </InsightSection>
  );
}

function SecretImpact({
  workspaceId,
  workspacePath,
}: Readonly<{ workspaceId: string; workspacePath: string }>): React.JSX.Element {
  const load = useInsightResource(`/workspaces/${encodeURIComponent(workspaceId)}/secret-impact`, resourceDocument);
  return (
    <InsightSection
      title="Sensitive input impact"
      description="Variable names and references only. No secret values are requested or displayed."
    >
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <>
          <InsightTable
            headings={["Variable", "Category", "Description"]}
            empty="No sensitive workspace variable metadata returned."
            rows={records(load.data.attributes["sources"]).map(
              (item): InsightTableRow => ({
                id: text(item["id"]),
                cells: [text(item["key"]), text(item["category"]), text(item["description"], "—")],
              }),
            )}
          />
          <InsightNotice>
            Changing a value affects future input capture. This report does not prove which external credentials a
            provider used or revoke an issued cloud credential.
          </InsightNotice>
          <JsonDetails value={load.data.attributes} label="Input impact evidence" />
          <Link className="text-sm text-primary hover:underline" to={`${workspacePath}/variables`}>
            Manage workspace variables
          </Link>
        </>
      )}
    </InsightSection>
  );
}

function VariableSetImpact({ id }: Readonly<{ id: string }>): React.JSX.Element {
  const load = useInsightResource(`/variable-sets/${encodeURIComponent(id)}/impact`, resourceDocument);
  return (
    <div className="space-y-3">
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <>
          <InsightNotice>
            This report lists explicitly linked, authorized workspaces. Global/project inheritance and exact secret
            version usage are not fully tracked here. An empty list does not prove there are no consumers.
          </InsightNotice>
          <InsightTable
            headings={["Workspace", "Retained planned runs"]}
            empty="No explicit authorized consumers in this bounded report."
            rows={records(load.data.attributes["consumers"]).map(
              (consumer, index): InsightTableRow => ({
                id: `${text(record(consumer["workspace"])["id"])}-${index}`,
                cells: [
                  text(record(consumer["workspace"])["name"]),
                  <div key="runs" className="space-y-2">
                    {records(consumer["planned-runs"]).map(
                      (run): React.JSX.Element => (
                        <p key={text(run["id"])} className="text-xs">
                          <code>{text(run["id"])}</code> <InsightStatus value={run["status"]} />
                        </p>
                      ),
                    )}
                  </div>,
                ],
              }),
            )}
          />
          <JsonDetails value={load.data.attributes} label="Variable-set impact evidence" />
        </>
      )}
    </div>
  );
}

function VariableSets({ workspaceId }: Readonly<{ workspaceId: string }>): React.JSX.Element {
  const load = useInsightResource(
    `/workspaces/${encodeURIComponent(workspaceId)}/varsets?page[size]=100`,
    collectionDocument,
  );
  const [selected, setSelected] = useState("");
  const available = load.data?.data ?? [];
  const id = available.some((item): boolean => item.id === selected) ? selected : "";
  return (
    <InsightSection
      title="Variable-set consumers"
      description="Inspect a linked variable set before changing shared inputs. At most 100 linked sets are shown."
    >
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <label className="block space-y-1 text-sm">
          Variable set
          <Select value={id} onValueChange={setSelected}>
            <option value="">Select a linked set</option>
            {available.map(
              (item): React.JSX.Element => (
                <option key={item.id} value={item.id}>
                  {text(item.attributes["name"], item.id)}
                </option>
              ),
            )}
          </Select>
        </label>
      )}
      {id !== "" && <VariableSetImpact key={id} id={id} />}
    </InsightSection>
  );
}

export function AccessInsights({
  workspaceId,
  workspacePath,
  canReadVariables,
}: Readonly<{ workspaceId: string; workspacePath: string; canReadVariables: boolean }>): React.JSX.Element {
  return (
    <div className="space-y-6">
      <CurrentAccess workspaceId={workspaceId} />
      {canReadVariables ? (
        <>
          <SecretImpact workspaceId={workspaceId} workspacePath={workspacePath} />
          <VariableSets workspaceId={workspaceId} />
        </>
      ) : (
        <InsightNotice>
          Sensitive input and variable-set impact require permission to read workspace variables.
        </InsightNotice>
      )}
    </div>
  );
}
