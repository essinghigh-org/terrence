import { AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { isAdvisoryPolicyIssue, policyResultText } from "@/lib/run-detail-format";
import type { PolicyCheck } from "@/lib/run-view-state";
import { Badge } from "../ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";

function PolicyCheckRow({ check }: Readonly<{ check: PolicyCheck }>): React.JSX.Element {
  return (
    <TableRow>
      <TableCell>
        <div className="text-sm font-medium">
          {check.attributes["policy-name"] ?? check.id}
        </div>
        {check.attributes["policy-name"] !== null
          && check.attributes["policy-name"] !== undefined && (
          <code className="text-2xs text-muted-foreground">{check.id}</code>
        )}
      </TableCell>
      <TableCell className="whitespace-normal">{policyResultText(check.attributes.result)}</TableCell>
      <TableCell>
        <Badge
          variant={["failed", "soft_failed", "hard_failed", "errored", "unreachable"].includes(check.attributes.status)
            && !isAdvisoryPolicyIssue(check)
            ? "destructive"
            : "secondary"}
          className="rounded capitalize"
        >
          {isAdvisoryPolicyIssue(check)
            ? `advisory ${check.attributes.status === "failed"
                ? "failed"
                : check.attributes.status.replace(/_/g, " ")}`
            : check.attributes.status.replace(/_/g, " ")}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

export function PolicySection({ policyChecks, policySummary, hasFailedPolicy }: Readonly<{
  policyChecks: readonly PolicyCheck[];
  policySummary: string;
  hasFailedPolicy: boolean;
}>): React.JSX.Element {
  return (
    <section aria-labelledby="policy-heading" className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="flex items-center gap-3">
          {hasFailedPolicy ? (
            <AlertCircle className="size-5 text-destructive" aria-hidden="true" />
          ) : policySummary === "checking" ? (
            <Clock className="size-5 text-primary" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="size-5 text-muted-foreground/70" aria-hidden="true" />
          )}
          <h3 id="policy-heading" className="font-semibold text-foreground">Policy check</h3>
        </div>
        <Badge variant={hasFailedPolicy ? "destructive" : "secondary"} className="rounded capitalize">
          {policySummary}
        </Badge>
      </div>
      {policyChecks.length > 0 && (
        <div className="border-t border-border px-5 py-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Check</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {policyChecks.map((check: PolicyCheck): React.JSX.Element => (
                <PolicyCheckRow key={check.id} check={check} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
