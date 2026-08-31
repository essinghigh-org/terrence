import type { JSX } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  PauseCircle,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { Badge } from "./badge";
import { cn } from "@/lib/utils";
import { formatRunStatus } from "@/lib/run-labels";

export type RunStatusType =
  | "pending"
  | "fetching"
  | "planning"
  | "planned"
  | "planned_and_saved"
  | "planned_and_finished"
  | "cost_estimating"
  | "cost_estimated"
  | "policy_checking"
  | "policy_override"
  | "policy_soft_failed"
  | "policy_hard_failed"
  | "applying"
  | "applied"
  | "errored"
  | "canceled"
  | "discarded"
  | "needs_confirmation"
  | string;

export function StatusBadge({
  status,
  className,
}: Readonly<{
  status?: RunStatusType | undefined;
  className?: string | undefined;
}>): JSX.Element {
  if (status === undefined || status === "") {
    return <span className="text-muted-foreground">—</span>;
  }

  const label = formatRunStatus(status);

  // Active running / planning / applying states
  if (["planning", "applying", "fetching", "cost_estimating", "policy_checking", "pending"].includes(status)) {
    return (
      <Badge
        variant="outline"
        className={cn(
          "inline-flex items-center gap-1.5 border-primary/25 bg-primary/10 text-primary font-medium",
          className,
        )}
      >
        <span className="relative flex size-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-primary" />
        </span>
        <Loader2 className="size-3 animate-spin shrink-0" />
        <span>{label}</span>
      </Badge>
    );
  }

  // Success / Finished states
  if (["applied", "planned_and_finished", "planned_and_saved", "cost_estimated"].includes(status)) {
    return (
      <Badge
        variant="secondary"
        className={cn(
          "inline-flex items-center gap-1.5 border-success/25 bg-success/10 text-success font-medium",
          className,
        )}
      >
        <CheckCircle2 className="size-3.5 shrink-0 text-success" />
        <span>{label}</span>
      </Badge>
    );
  }

  // Needs Attention / Confirmation / Policy soft fail
  if (["planned", "needs_confirmation", "policy_soft_failed", "policy_override"].includes(status)) {
    return (
      <Badge
        variant="secondary"
        className={cn(
          "inline-flex items-center gap-1.5 border-warning/30 bg-warning/10 text-warning font-medium",
          className,
        )}
      >
        <PauseCircle className="size-3.5 shrink-0 text-warning" />
        <span>{label}</span>
      </Badge>
    );
  }

  // Errored / Policy hard failed / Canceled
  if (["errored", "policy_hard_failed", "canceled"].includes(status)) {
    return (
      <Badge
        variant="destructive"
        className={cn("inline-flex items-center gap-1.5 font-medium", className)}
      >
        {status === "policy_hard_failed" ? (
          <ShieldAlert className="size-3.5 shrink-0" />
        ) : (
          <XCircle className="size-3.5 shrink-0" />
        )}
        <span>{label}</span>
      </Badge>
    );
  }

  // Discarded / Muted
  if (status === "discarded") {
    return (
      <Badge variant="outline" className={cn("inline-flex items-center gap-1.5 text-muted-foreground", className)}>
        <AlertCircle className="size-3.5 shrink-0" />
        <span>{label}</span>
      </Badge>
    );
  }

  // Default fallback badge
  return (
    <Badge variant="secondary" className={cn("inline-flex items-center gap-1.5", className)}>
      <Clock className="size-3.5 shrink-0 text-muted-foreground" />
      <span>{label}</span>
    </Badge>
  );
}