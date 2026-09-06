/* eslint-disable @typescript-eslint/naming-convention -- Terraform plan/apply JSON fields are snake_case. */
import { Trash2 } from "lucide-react";
import type { DeepReadonly } from "@/lib/utils";

export type Change = {
  actions: string[];
  before: unknown;
  after: unknown;
  after_unknown?: unknown;
  before_sensitive?: unknown;
  after_sensitive?: unknown;
  replace_paths?: readonly (readonly (string | number)[])[];
  importing?: {
    id?: string;
    unknown?: boolean;
  };
};

export type ResourceChange = {
  address: string;
  deposed?: string;
  module_address?: string;
  mode?: string;
  type: string;
  name?: string;
  previous_address?: string;
  provider_name?: string;
  action_reason?: string;
  change: Change;
};

export type Operation = "create" | "update" | "delete" | "replace" | "read" | "import" | "move" | "remove" | "unsupported" | "no-op";

export const OPERATION_OPTIONS: readonly Operation[] = ["create", "update", "delete", "replace", "move", "import", "remove", "read", "unsupported"];
export const APPLY_OPERATION_OPTIONS: readonly Operation[] = ["create", "update", "delete", "replace", "move", "import", "remove", "unsupported"];

// Reads are data-source refreshes, not real changes; everything else is
// selected by default.
export const DEFAULT_SELECTED_OPS: ReadonlySet<Operation> = new Set(
  OPERATION_OPTIONS.filter((op): boolean => op !== "read"),
);
export const DEFAULT_APPLY_OPS: ReadonlySet<Operation> = new Set(APPLY_OPERATION_OPTIONS);

export const operationConfig = {
  create: { symbol: "+", className: "text-success" },
  update: { symbol: "~", className: "text-primary" },
  delete: { icon: Trash2, className: "text-destructive" },
  replace: { symbol: "±", className: "text-warning" },
  read: { symbol: "◎", className: "text-primary" },
  import: { symbol: "&", className: "text-foreground" },
  move: { symbol: "→", className: "text-foreground/85" },
  remove: { icon: Trash2, className: "text-muted-foreground/70" },
  unsupported: { symbol: "?", className: "text-warning" },
  "no-op": { symbol: "·", className: "text-muted-foreground/70" },
} satisfies Record<Operation, Readonly<{ symbol?: string; icon?: typeof Trash2; className: string }>>;

export function operationFor(actions: readonly string[]): Operation {
  // Action reasons explain why; only the action says whether an object is destroyed.
  if (actions.length === 0 || actions.some((action): boolean => !["no-op", "create", "read", "update", "delete", "forget"].includes(action))) return "unsupported";
  if (actions.length === 2 && actions.includes("create") && actions.includes("delete")) return "replace";
  if (actions.length !== 1) return "unsupported";
  if (actions[0] === "forget") return "remove";
  if (actions[0] === "create") return "create";
  if (actions[0] === "delete") return "delete";
  if (actions[0] === "update") return "update";
  if (actions[0] === "read") return "read";
  return "no-op";
}

export function operationForResource(resource: DeepReadonly<ResourceChange>): Operation {
  const operation = operationFor(resource.change.actions);
  if (operation !== "no-op") return operation;
  if (resource.change.importing !== undefined) return "import";
  if (resource.previous_address !== undefined) return "move";
  return "no-op";
}
