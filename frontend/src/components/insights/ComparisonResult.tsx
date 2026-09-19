import { record, records, text, type InsightRecord } from "../../lib/insights-api";
import { InsightNotice, InsightTable, JsonDetails } from "./InsightUI";

type ChangeRow = Readonly<{ id: string; cells: readonly React.ReactNode[] }>;
const GROUPS = ["added", "removed", "changed", "moved"] as const;

function changeRows(resources: InsightRecord, kind: "state" | "plan"): readonly ChangeRow[] {
  return GROUPS.flatMap((group): readonly ChangeRow[] =>
    records(resources[group]).map(
      (item, index): ChangeRow => ({
        id: `${group}-${index}`,
        cells: [
          kind === "plan" && group === "removed" ? "No longer in plan" : group,
          <code key="address" className="text-xs">
            {text(item["address"] ?? item["to"] ?? item["name"])}
          </code>,
          <div key="detail" className="space-y-2">
            {(item["newly-destructive"] === true || item["destructive"] === true) && (
              <p className="text-destructive font-medium">Includes destruction</p>
            )}
            {typeof item["from"] === "string" && <p className="text-xs">From {item["from"]}</p>}
            <JsonDetails value={item} label="Change details" />
          </div>,
        ],
      }),
    ),
  );
}

export function ComparisonResult({
  attributes,
  kind,
}: Readonly<{ attributes: InsightRecord; kind: "state" | "plan" }>): React.JSX.Element {
  const comparison = record(attributes["comparison"]);
  const resources = record(comparison["resources"]);
  const complete = GROUPS.every((group): boolean => Array.isArray(resources[group]));
  if (!complete)
    return (
      <InsightNotice>
        The response did not contain a complete comparison. No change count can be inferred.
      </InsightNotice>
    );
  const limited = comparison["mode"] === "limited";
  const outputs = record(comparison["outputs"]);
  return (
    <div className="space-y-4" aria-live="polite">
      {limited ? (
        <InsightNotice>
          This comparison is limited because a retained state representation is unavailable. Empty change lists do not
          mean the states are identical.
        </InsightNotice>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {GROUPS.map(
            (group): React.JSX.Element => (
              <div key={group} className="rounded-md border border-border px-4 py-3">
                <p className="text-xs capitalize text-muted-foreground">{group}</p>
                <p className="mt-1 text-xl font-semibold">{records(resources[group]).length}</p>
              </div>
            ),
          )}
        </div>
      )}
      <InsightNotice>
        {kind === "plan"
          ? "This compares two retained public plan projections, not live cloud state. Sensitive values are excluded. A resource disappearing from the plan is not proof it was destroyed."
          : "This compares retained state evidence, not live cloud resources. Sensitive values remain masked."}
      </InsightNotice>
      {!limited && (
        <InsightTable
          headings={["Change", "Resource", "Evidence"]}
          rows={changeRows(resources, kind)}
          empty="No resource differences were found in the comparable projection."
        />
      )}
      <JsonDetails
        value={{
          before: comparison["before"],
          after: comparison["after"],
          outputs,
          provenance: comparison["provenance"],
        }}
        label="Baselines, output changes and provenance"
      />
    </div>
  );
}
