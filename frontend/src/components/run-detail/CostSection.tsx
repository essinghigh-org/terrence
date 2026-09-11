import { CheckCircle2, Clock, Info, XCircle } from "lucide-react";
import { formatMonthlyCost } from "@/lib/run-detail-format";
import type { CostModel, CostResourceChange } from "@/lib/run-detail-model";
import { Badge } from "../ui/badge";

function CostEstimateGrid({ cost }: Readonly<{ cost: CostModel }>): React.JSX.Element {
  const costAttributes = cost.costAttributes;
  if (costAttributes === undefined) return <></>;
  return (
    <dl aria-label="Cost estimate details" className="grid grid-cols-2 gap-4 border-t border-border px-5 py-4 text-sm md:grid-cols-4">
      {!cost.costUnavailable && (
        <>
          <div>
            <dt className="text-xs text-muted-foreground">{cost.costBaselineComparable ? `Prior ${cost.costTimeBasis}` : "Baseline"}</dt>
            <dd className="mt-1 font-medium">{cost.costBaselineComparable ? formatMonthlyCost(costAttributes["prior-monthly-cost"], cost.costCurrency, cost.costTimeBasis) : "Not comparable"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Proposed {cost.costTimeBasis}</dt>
            <dd className="mt-1 font-medium">{formatMonthlyCost(costAttributes["proposed-monthly-cost"], cost.costCurrency, cost.costTimeBasis)}</dd>
          </div>
          {cost.costBaselineComparable && (
            <div>
              <dt className="text-xs text-muted-foreground">{cost.costTimeBasis} delta</dt>
              <dd className="mt-1 font-medium">{formatMonthlyCost(costAttributes["delta-monthly-cost"], cost.costCurrency, cost.costTimeBasis)}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-muted-foreground">Priced resources</dt>
            <dd className="mt-1 font-medium">
              {costAttributes["matched-resources-count"] ?? 0} of {costAttributes["resources-count"] ?? 0}
            </dd>
          </div>
        </>
      )}
      {((costAttributes["error-message"] !== null && costAttributes["error-message"] !== undefined) || cost.costUnavailable) && (
        <div className={cost.costUnavailable ? "col-span-full text-muted-foreground" : "col-span-full text-destructive"}>{costAttributes["error-message"] ?? "Cost estimation is not installed in this image."}</div>
      )}
    </dl>
  );
}

function CostProvenanceLine({ cost }: Readonly<{ cost: CostModel }>): React.JSX.Element | null {
  const costProvenance = cost.costProvenance;
  if (costProvenance === undefined) return null;
  return (
    <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
      Pricing provenance: {costProvenance.tool ?? "estimator"}{costProvenance.version === null || costProvenance.version === undefined ? "" : ` ${costProvenance.version}`}
      {costProvenance.currency === null || costProvenance.currency === undefined ? "" : ` · ${costProvenance.currency}`}
      {costProvenance["time-basis"] === null || costProvenance["time-basis"] === undefined ? "" : ` · ${costProvenance["time-basis"]}`}
      {costProvenance["pricing-date"] === null || costProvenance["pricing-date"] === undefined ? "" : ` · pricing ${costProvenance["pricing-date"]}`}
    </p>
  );
}

function CostIncreaseRow({ change, costCurrency, costTimeBasis }: Readonly<{
  change: CostResourceChange;
  costCurrency: string;
  costTimeBasis: string;
}>): React.JSX.Element {
  const moduleName = change.module ?? "default";
  const address = change.address ?? "unknown resource";
  return (
    <li key={`${moduleName}:${address}`}>
      <a href="#plan-heading" className="font-mono text-primary underline-offset-2 hover:underline">{moduleName}:{address}</a>
      <span className="ml-2">+{formatMonthlyCost(change["delta-monthly-cost"] ?? undefined, costCurrency, costTimeBasis)}</span>
    </li>
  );
}

export function CostSection({ cost }: Readonly<{ cost: CostModel }>): React.JSX.Element {
  return (
    <section aria-labelledby="cost-heading" className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-center gap-3">
          {cost.costPending ? (
            <Clock className="size-5 text-primary" aria-hidden="true" />
          ) : cost.costFailed ? (
            <XCircle className="size-5 text-destructive" aria-hidden="true" />
          ) : cost.costUnavailable ? (
            <Info className="size-5 text-muted-foreground" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="size-5 text-muted-foreground/70" aria-hidden="true" />
          )}
          <h3 id="cost-heading" className="font-semibold text-foreground">Cost estimation</h3>
        </div>
        <Badge variant={cost.costFailed ? "destructive" : "secondary"} className="rounded capitalize">{cost.costStatus}</Badge>
      </div>
      {cost.costAttributes !== undefined && (
        <CostEstimateGrid cost={cost} />
      )}
      <CostProvenanceLine cost={cost} />
      {cost.costWarnings.length > 0 && (
        <div role="note" className="border-t border-warning/30 bg-warning/5 px-5 py-3 text-xs text-warning-text">
          <p className="font-medium">Estimate caveats</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">{cost.costWarnings.map((warning): React.JSX.Element => <li key={warning}>{warning}</li>)}</ul>
        </div>
      )}
      {cost.costComparison?.baseline?.comparable === false && cost.costComparison.baseline.reason !== null && cost.costComparison.baseline.reason !== undefined && (
        <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">Baseline comparison is unavailable: {cost.costComparison.baseline.reason}</p>
      )}
      {cost.largestCostIncreases.length > 0 && (
        <details className="border-t border-border px-5 py-3 text-xs">
          <summary className="cursor-pointer font-medium text-foreground">Largest planned cost increases</summary>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            {cost.largestCostIncreases.map((change): React.JSX.Element => (
              <CostIncreaseRow
                key={`${change.module ?? "default"}:${change.address ?? "unknown resource"}`}
                change={change}
                costCurrency={cost.costCurrency}
                costTimeBasis={cost.costTimeBasis}
              />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
