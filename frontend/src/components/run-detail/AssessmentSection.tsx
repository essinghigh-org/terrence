import { ChevronRight } from "lucide-react";
import { isString } from "@/lib/type-guards";
import type { AssessmentCheck } from "@/lib/run-view-state";
import { Badge } from "../ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";

export function AssessmentSection({ assessmentChecks }: Readonly<{
  assessmentChecks: readonly AssessmentCheck[];
}>): React.JSX.Element {
  return (
    <details aria-labelledby="assessment-heading" className="group overflow-hidden rounded-lg border border-border bg-card">
      <summary className="cursor-pointer list-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <div className="flex items-center justify-between gap-3 px-5 py-4 group-open:border-b group-open:border-border">
          <div className="flex items-center gap-3">
            <ChevronRight className="size-4 text-muted-foreground/70 transition-transform group-open:rotate-90" aria-hidden="true" />
            <div>
              <h3 id="assessment-heading" className="font-semibold text-foreground">Health checks</h3>
              <p className="mt-1 text-xs text-muted-foreground">Terraform checks and drift validation reported for this run.</p>
            </div>
          </div>
          <Badge variant={assessmentChecks.some((check): boolean => ["failed", "errored"].includes(check.attributes.status)) ? "destructive" : "secondary"}>
            {assessmentChecks.filter((check): boolean => check.attributes.status === "passed").length} / {assessmentChecks.length} passed
          </Badge>
        </div>
      </summary>
      <div className="px-5 py-3">
        <Table>
          <TableHeader><TableRow><TableHead>Check</TableHead><TableHead>Result</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
          <TableBody>
            {assessmentChecks.map((check): React.JSX.Element => (
              <TableRow key={check.id}>
                <TableCell>
                  <div className="font-medium">{check.attributes.address ?? check.id}</div>
                  {check.attributes.kind !== null && check.attributes.kind !== undefined && <div className="text-xs text-muted-foreground">{check.attributes.kind}</div>}
                </TableCell>
                <TableCell className="whitespace-normal">{check.attributes.message ?? (isString(check.attributes.detail) ? check.attributes.detail : "—")}</TableCell>
                <TableCell><Badge variant={["failed", "errored"].includes(check.attributes.status) ? "destructive" : "secondary"}>{check.attributes.status.replace(/_/g, " ")}</Badge></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </details>
  );
}
