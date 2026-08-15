/* eslint-disable @typescript-eslint/naming-convention -- Terraform plan JSON fields are snake_case. */
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  Trash2,
} from "lucide-react";
import { ApiError, fetchApi } from "../lib/api";
import { Spinner } from "./ui/spinner";

type Change = {
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

type ResourceChange = {
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

type ActionInvocation = {
  address?: string;
  type?: string;
  name?: string;
  provider_name?: string;
  lifecycle_action_trigger?: {
    triggering_resource_address?: string;
    action_trigger_event?: string;
  };
  invoke_action_trigger?: Record<string, unknown>;
};

type PlanJson = {
  action_invocations?: ActionInvocation[];
  configuration?: unknown;
  resource_drift?: ResourceChange[];
  resource_changes?: ResourceChange[];
  output_changes?: Record<string, Change>;
  terraform_version?: string;
  format_version?: string;
};

type Operation = "create" | "update" | "delete" | "replace" | "read" | "import" | "move" | "remove" | "no-op";

const OPERATION_OPTIONS: readonly Operation[] = ["create", "update", "delete", "replace", "move", "import", "remove", "read"];
// Reads are data-source refreshes, not real changes; everything else is
// selected by default.
const DEFAULT_SELECTED_OPS: ReadonlySet<Operation> = new Set(
  OPERATION_OPTIONS.filter((op): boolean => op !== "read"),
);

type DiffRow = Readonly<{
  path: string;
  before: unknown;
  after: unknown;
  sensitive: boolean;
  unknown: boolean;
  unchanged: boolean;
}>;

type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "waiting" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "ready"; plan: PlanJson }>;

export type PlanOutputSummary = Readonly<{ actionCount: number; importCount: number }>;

const POLL_INTERVAL_MS = 1_000;
const PLAN_PENDING_STATUSES = new Set([
  "pending",
  "fetching",
  "fetching_completed",
  "pre_plan_running",
  "pre_plan_completed",
  "queuing",
  "plan_queued",
  "planning",
]);
const PLANLESS_TERMINAL_STATUSES = new Set([
  "canceled",
  "discarded",
  "errored",
  "failed",
  "force_canceled",
  "unreachable",
]);

const operationConfig = {
  create: { symbol: "+", className: "text-success" },
  update: { symbol: "~", className: "text-primary" },
  delete: { icon: Trash2, className: "text-destructive" },
  replace: { symbol: "±", className: "text-warning" },
  read: { symbol: "◎", className: "text-primary" },
  import: { symbol: "&", className: "text-foreground" },
  move: { symbol: "→", className: "text-foreground/85" },
  remove: { icon: Trash2, className: "text-muted-foreground/70" },
  "no-op": { symbol: "·", className: "text-muted-foreground/70" },
} satisfies Record<Operation, Readonly<{ symbol?: string; icon?: typeof Trash2; className: string }>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChange(value: unknown): value is Change {
  if (!isRecord(value)
    || !Array.isArray(value["actions"])
    || !value["actions"].every((action: unknown): boolean => typeof action === "string")) return false;
  const importing = value["importing"];
  const replacePaths = value["replace_paths"];
  return (importing === undefined || (
      isRecord(importing)
      && (importing["id"] === undefined || typeof importing["id"] === "string")
      && (importing["unknown"] === undefined || typeof importing["unknown"] === "boolean")
    ))
    && (replacePaths === undefined || (
      Array.isArray(replacePaths)
      && replacePaths.every((path: unknown): boolean =>
        Array.isArray(path)
        && path.every((step: unknown): boolean => typeof step === "string" || typeof step === "number"),
      )
    ));
}

function isResourceChange(value: unknown): value is ResourceChange {
  return isRecord(value)
    && typeof value["address"] === "string"
    && typeof value["type"] === "string"
    && (value["deposed"] === undefined || typeof value["deposed"] === "string")
    && (value["module_address"] === undefined || typeof value["module_address"] === "string")
    && (value["mode"] === undefined || typeof value["mode"] === "string")
    && (value["name"] === undefined || typeof value["name"] === "string")
    && (value["previous_address"] === undefined || typeof value["previous_address"] === "string")
    && (value["provider_name"] === undefined || typeof value["provider_name"] === "string")
    && (value["action_reason"] === undefined || typeof value["action_reason"] === "string")
    && isChange(value["change"]);
}

function isActionInvocation(value: unknown): value is ActionInvocation {
  if (!isRecord(value)
    || (value["address"] !== undefined && typeof value["address"] !== "string")
    || (value["type"] !== undefined && typeof value["type"] !== "string")
    || (value["name"] !== undefined && typeof value["name"] !== "string")
    || (value["provider_name"] !== undefined && typeof value["provider_name"] !== "string")) return false;
  const lifecycleTrigger = value["lifecycle_action_trigger"];
  return (lifecycleTrigger === undefined || (
      isRecord(lifecycleTrigger)
      && (lifecycleTrigger["triggering_resource_address"] === undefined
        || typeof lifecycleTrigger["triggering_resource_address"] === "string")
      && (lifecycleTrigger["action_trigger_event"] === undefined
        || typeof lifecycleTrigger["action_trigger_event"] === "string")
    ))
    && (value["invoke_action_trigger"] === undefined || isRecord(value["invoke_action_trigger"]));
}

function parsePlanJson(value: unknown): PlanJson | null {
  if (!isRecord(value)) return null;
  const actions = value["action_invocations"];
  const resources = value["resource_changes"];
  const drift = value["resource_drift"];
  const outputs = value["output_changes"];
  if (actions !== undefined
    && (!Array.isArray(actions) || !actions.every(isActionInvocation))) return null;
  if (resources !== undefined
    && (!Array.isArray(resources) || !resources.every(isResourceChange))) return null;
  if (drift !== undefined
    && (!Array.isArray(drift) || !drift.every(isResourceChange))) return null;
  if (outputs !== undefined
    && (!isRecord(outputs) || !Object.values(outputs).every(isChange))) return null;
  if (value["terraform_version"] !== undefined && typeof value["terraform_version"] !== "string") return null;
  if (value["format_version"] !== undefined && typeof value["format_version"] !== "string") return null;
  return value;
}

function operationFor(actions: readonly string[], actionReason?: string): Operation {
  if (actions.includes("create") && actions.includes("delete")) return "replace";
  if (actions.includes("create")) return "create";
  if (actions.includes("delete")) {
    if (actionReason === "delete_because_no_resource_config" || actionReason === "removed_from_state") {
      return "remove";
    }
    return "delete";
  }
  if (actions.includes("update")) return "update";
  if (actions.includes("read")) return "read";
  return "no-op";
}

function operationForResource(resource: ResourceChange): Operation {
  const operation = operationFor(resource.change.actions, resource.action_reason);
  if (operation !== "no-op") return operation;
  if (resource.change.importing !== undefined) return "import";
  if (resource.previous_address !== undefined) return "move";
  return "no-op";
}

function collectionKeys(values: readonly unknown[]): readonly (string | number)[] {
  const arrays = values.filter(Array.isArray);
  if (arrays.length > 0) {
    const length = Math.max(...arrays.map((value): number => value.length), 0);
    return Array.from({ length }, (_, index): number => index);
  }
  const keys = new Set<string>();
  for (const value of values) {
    if (isRecord(value)) {
      for (const key of Object.keys(value)) keys.add(key);
    }
  }
  return [...keys].sort((left, right): number => left.localeCompare(right));
}

function childValue(value: unknown, key: string | number): unknown {
  if (typeof key === "number") return Array.isArray(value) ? value[key] : undefined;
  return isRecord(value) ? value[key] : undefined;
}

function formatPath(path: readonly (string | number)[]): string {
  return path.reduce<string>((value, step): string =>
    typeof step === "number"
      ? `${value}[${step}]`
      : value === "" ? step : `${value}.${step}`,
  "");
}

function collectDiffRows(
  path: string,
  before: unknown,
  after: unknown,
  beforeSensitive: unknown,
  afterSensitive: unknown,
  afterUnknown: unknown,
): readonly DiffRow[] {
  const sensitive = beforeSensitive === true || afterSensitive === true;
  const unknown = afterUnknown === true;
  const equal = JSON.stringify(before) === JSON.stringify(after);
  if (sensitive || unknown) {
    return [{
      path: path === "" ? "value" : path,
      before,
      after,
      sensitive,
      unknown,
      unchanged: equal && !unknown,
    }];
  }

  const values = [before, after, beforeSensitive, afterSensitive, afterUnknown];
  const keys = collectionKeys(values);
  if (keys.length > 0) {
    return keys.flatMap((key): readonly DiffRow[] => {
      const childPath = typeof key === "number"
        ? `${path}[${key}]`
        : path === "" ? key : `${path}.${key}`;
      return collectDiffRows(
        childPath,
        childValue(before, key),
        childValue(after, key),
        childValue(beforeSensitive, key),
        childValue(afterSensitive, key),
        childValue(afterUnknown, key),
      );
    });
  }
  return [{
    path: path === "" ? "value" : path,
    before,
    after,
    sensitive: false,
    unknown: false,
    unchanged: equal,
  }];
}

function attributeDiff(change: Change): readonly DiffRow[] {
  return collectDiffRows(
    "",
    change.before,
    change.after,
    change.before_sensitive,
    change.after_sensitive,
    change.after_unknown,
  );
}

function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return Array.isArray(value) ? "[…]" : "{…}";
}

type DiffNode =
  | Readonly<{
      kind: "leaf";
      key: string | number | null;
      path: string;
      before: unknown;
      after: unknown;
      unchanged: boolean;
      sensitive: boolean;
      unknown: boolean;
    }>
  | Readonly<{
      kind: "object" | "array";
      key: string | number | null;
      path: string;
      before: unknown;
      after: unknown;
      unchanged: boolean;
      added: boolean;
      removed: boolean;
      children: readonly DiffNode[];
    }>;

function buildDiffNode(
  key: string | number | null,
  path: string,
  before: unknown,
  after: unknown,
  beforeSensitive: unknown,
  afterSensitive: unknown,
  afterUnknown: unknown,
): DiffNode {
  const equal = JSON.stringify(before) === JSON.stringify(after);
  if (beforeSensitive === true || afterSensitive === true || afterUnknown === true) {
    return {
      kind: "leaf",
      key,
      path,
      before,
      after,
      unchanged: equal,
      sensitive: beforeSensitive === true || afterSensitive === true,
      unknown: afterUnknown === true,
    };
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    const length = Math.max(
      Array.isArray(before) ? before.length : 0,
      Array.isArray(after) ? after.length : 0,
    );
    const children: DiffNode[] = [];
    for (let index = 0; index < length; index++) {
      children.push(buildDiffNode(
        index,
        path === "" ? `[${index}]` : `${path}[${index}]`,
        Array.isArray(before) ? before[index] : undefined,
        Array.isArray(after) ? after[index] : undefined,
        Array.isArray(beforeSensitive) ? beforeSensitive[index] : undefined,
        Array.isArray(afterSensitive) ? afterSensitive[index] : undefined,
        Array.isArray(afterUnknown) ? afterUnknown[index] : undefined,
      ));
    }
    return {
      kind: "array",
      key,
      path,
      before,
      after,
      unchanged: equal,
      added: before === undefined || before === null,
      removed: after === undefined || after === null,
      children,
    };
  }
  if (isRecord(before) || isRecord(after)) {
    const keys = collectionKeys([before, after, beforeSensitive, afterSensitive, afterUnknown]);
    const children = keys.map((childKey): DiffNode => buildDiffNode(
      childKey,
      path === "" ? String(childKey) : `${path}.${childKey}`,
      childValue(before, childKey),
      childValue(after, childKey),
      childValue(beforeSensitive, childKey),
      childValue(afterSensitive, childKey),
      childValue(afterUnknown, childKey),
    ));
    return {
      kind: "object",
      key,
      path,
      before,
      after,
      unchanged: equal,
      added: before === undefined || before === null,
      removed: after === undefined || after === null,
      children,
    };
  }
  return {
    kind: "leaf",
    key,
    path,
    before,
    after,
    unchanged: equal,
    sensitive: false,
    unknown: false,
  };
}

type DiffLine = {
  depth: number;
  path: string;
  parts: readonly { text: string; cls: string }[];
  replacement: boolean;
};

type DiffMarker = "add" | "del" | "mod";
const diffMarkerClasses = {
  add: "text-success",
  del: "text-destructive",
  mod: "text-primary",
};
const diffMarkerText = {
  add: "+",
  del: "-",
  mod: "~",
};

function diffMarkerFor(node: DiffNode, force: "add" | "del" | null): DiffMarker | null {
  if (force === "add") return "add";
  if (force === "del") return "del";
  if (node.unchanged) return null;
  if (node.kind === "leaf") {
    if (node.before === undefined) return "add";
    if (node.after === undefined) return "del";
    return "mod";
  }
  if (node.added) return "add";
  if (node.removed) return "del";
  return "mod";
}

function maxKeyWidth(children: readonly DiffNode[]): number {
  return children.reduce((width: number, child: DiffNode): number =>
    Math.max(width, child.key === null ? 0 : String(child.key).length), 0);
}

function padKeyText(key: string | number, width: number): string {
  const text = String(key);
  return text + " ".repeat(Math.max(0, width - text.length));
}

function emitArrayItemBlock(
  node: Extract<DiffNode, { kind: "object" | "array" }>,
  force: "add" | "del",
  context: ReadonlySet<string>,
  depth: number,
  forcesReplacement: (path: string) => boolean,
  lines: DiffLine[],
): void {
  const marker = force === "add" ? "add" : "del";
  const open = node.kind === "array" ? "[" : "{";
  const close = node.kind === "array" ? "]" : "}";
  lines.push({
    depth,
    path: node.path,
    parts: [{ text: `${diffMarkerText[marker]} ${open}`, cls: diffMarkerClasses[marker] }],
    replacement: forcesReplacement(node.path),
  });
  const childDepth = depth + 1;
  const width = node.kind === "object" ? maxKeyWidth(node.children) : 0;
  for (const child of node.children) {
    flattenDiff(
      child,
      context,
      force,
      childDepth,
      node.kind === "object" && child.key !== null ? padKeyText(child.key, width) : null,
      node.kind === "array",
      forcesReplacement,
      lines,
    );
  }
  lines.push({
    depth,
    path: node.path,
    parts: [{ text: close, cls: "text-muted-foreground/70" }],
    replacement: false,
  });
}

function flattenDiff(
  node: DiffNode,
  context: ReadonlySet<string>,
  force: "add" | "del" | null,
  depth: number,
  keyText: string | null,
  inArray: boolean,
  forcesReplacement: (path: string) => boolean,
  lines: DiffLine[],
): void {
  if (node.kind === "leaf") {
    if (node.unchanged && force === null && !context.has(node.path)) return;
    const marker = diffMarkerFor(node, force);
    if (inArray && marker === "mod") {
      lines.push({
        depth,
        path: node.path,
        parts: [
          { text: "- ", cls: diffMarkerClasses.del },
          { text: formatValue(node.before), cls: "text-foreground/85" },
          { text: ",", cls: "text-muted-foreground/70" },
        ],
        replacement: forcesReplacement(node.path),
      });
      lines.push({
        depth,
        path: node.path,
        parts: [
          { text: "+ ", cls: diffMarkerClasses.add },
          { text: formatValue(node.after), cls: "text-foreground/85" },
          { text: ",", cls: "text-muted-foreground/70" },
        ],
        replacement: forcesReplacement(node.path),
      });
      return;
    }
    const parts: { text: string; cls: string }[] = [];
    if (marker !== null) parts.push({ text: `${diffMarkerText[marker]} `, cls: diffMarkerClasses[marker] });
    if (keyText !== null) {
      parts.push({ text: keyText, cls: "text-foreground" });
      parts.push({ text: " = ", cls: "text-muted-foreground/70" });
    }
    if (node.sensitive) {
      parts.push({ text: "Sensitive value", cls: "font-medium italic text-muted-foreground" });
    } else if (node.unknown) {
      parts.push({ text: "Known after apply", cls: "font-medium italic text-primary" });
    } else if (marker === "mod") {
      parts.push({ text: formatValue(node.before), cls: "text-foreground/85" });
      parts.push({ text: " -> ", cls: "text-muted-foreground/70" });
      parts.push({ text: formatValue(node.after), cls: "text-foreground/85" });
    } else {
      parts.push({
        text: formatValue(marker === "del" ? node.before : node.after),
        cls: node.unchanged ? "text-muted-foreground" : "text-foreground/85",
      });
    }
    if (inArray) parts.push({ text: ",", cls: "text-muted-foreground/70" });
    lines.push({ depth, path: node.path, parts, replacement: forcesReplacement(node.path) });
    return;
  }

  const isRoot = node.key === null && keyText === null && !inArray;
  if (!isRoot && node.unchanged && force === null) return;
  const marker = diffMarkerFor(node, force);
  const childForce: "add" | "del" | null = force ?? (node.added ? "add" : node.removed ? "del" : null);
  const childDepth = depth + 1;
  const width = node.kind === "object" ? maxKeyWidth(node.children) : 0;

  if (isRoot) {
    for (const child of node.children) {
      flattenDiff(
        child,
        context,
        childForce,
        depth,
        node.kind === "object" && child.key !== null ? padKeyText(child.key, width) : null,
        node.kind === "array",
        forcesReplacement,
        lines,
      );
    }
    return;
  }

  if (inArray) {
    if (marker === "mod" && force === null) {
      emitArrayItemBlock(node, "del", context, depth, forcesReplacement, lines);
      emitArrayItemBlock(node, "add", context, depth, forcesReplacement, lines);
    } else {
      emitArrayItemBlock(node, childForce ?? "del", context, depth, forcesReplacement, lines);
    }
    return;
  }

  const open = node.kind === "array" ? "[" : "{";
  const close = node.kind === "array" ? "]" : "}";
  const keyedParts: { text: string; cls: string }[] = [];
  if (marker !== null) keyedParts.push({ text: `${diffMarkerText[marker]} `, cls: diffMarkerClasses[marker] });
  keyedParts.push({ text: keyText ?? "", cls: "text-foreground" });
  keyedParts.push({ text: ` = ${open}`, cls: "text-muted-foreground/70" });
  lines.push({ depth, path: node.path, parts: keyedParts, replacement: forcesReplacement(node.path) });
  for (const child of node.children) {
    flattenDiff(
      child,
      context,
      childForce,
      childDepth,
      node.kind === "object" && child.key !== null ? padKeyText(child.key, width) : null,
      node.kind === "array",
      forcesReplacement,
      lines,
    );
  }
  lines.push({ depth, path: node.path, parts: [{ text: close, cls: "text-muted-foreground/70" }], replacement: false });
}

export function AttributeDiff({
  change,
  address,
  type,
  name,
}: Readonly<{ change: Change; address: string; type?: string | undefined; name?: string | undefined }>): React.JSX.Element {
  const rows = attributeDiff(change);
  const contextualUnchanged = new Set(
    rows
      .filter((row): boolean => row.unchanged && !row.sensitive && ["id", "name"].includes(row.path))
      .map((row): string => row.path),
  );
  const visibleRows = rows.filter((row) => !row.unchanged || contextualUnchanged.has(row.path));
  const hiddenUnchanged = rows.filter((row) => row.unchanged).length - contextualUnchanged.size;
  const replacementPaths = (change.replace_paths ?? []).map(formatPath);
  const forcesReplacement = (path: string): boolean => replacementPaths.some((replacementPath): boolean =>
    path === replacementPath
    || path.startsWith(`${replacementPath}.`)
    || path.startsWith(`${replacementPath}[`),
  );
  const unchangedSummary = hiddenUnchanged > 0
    ? `${hiddenUnchanged} unchanged attribute${hiddenUnchanged === 1 ? "" : "s"} hidden`
    : "";
  if (visibleRows.length === 0) {
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground">
        No attribute-level changes to show.{unchangedSummary === "" ? "" : ` ${unchangedSummary}.`}
      </p>
    );
  }

  const header = type !== undefined && name !== undefined
    ? (() => {
        const op = operationFor(change.actions);
        if (op === "create") return { text: "+", cls: diffMarkerClasses.add };
        if (op === "delete" || op === "remove") return { text: "-", cls: diffMarkerClasses.del };
        if (op === "replace") return { text: "-/", cls: "text-warning" };
        return { text: "~", cls: diffMarkerClasses.mod };
      })()
    : null;
  const hasHeader = header !== null;

  const root = buildDiffNode(
    null,
    "",
    change.before,
    change.after,
    change.before_sensitive,
    change.after_sensitive,
    change.after_unknown,
  );
  const lines: DiffLine[] = [];
  if (hasHeader) {
    lines.push({
      depth: 0,
      path: "",
      parts: [
        { text: `${header.text} resource `, cls: header.cls },
        { text: `"${type}" "${name}" {`, cls: "text-foreground" },
      ],
      replacement: false,
    });
  }
  flattenDiff(
    root,
    contextualUnchanged,
    null,
    hasHeader ? 1 : 0,
    root.kind === "leaf" ? "value" : null,
    false,
    forcesReplacement,
    lines,
  );
  if (unchangedSummary !== "") {
    lines.push({
      depth: 1,
      path: "",
      parts: [{ text: `# (${unchangedSummary})`, cls: "text-primary" }],
      replacement: false,
    });
  }
  if (hasHeader) {
    lines.push({ depth: 0, path: "", parts: [{ text: "}", cls: "text-muted-foreground/70" }], replacement: false });
  }

  return (
    <div aria-label={`Attribute changes for ${address}`} className="overflow-x-auto border-t border-border bg-muted px-4 pb-3">
      <div className="min-w-[560px] py-2 font-mono text-xs leading-5">
        {lines.map((line, index): React.JSX.Element => (
          <div key={index} className="flex items-baseline whitespace-pre">
            <code>
              <span className="text-muted-foreground/70">{" ".repeat(line.depth * 2)}</span>
              {line.parts.map((part, partIndex): React.JSX.Element => (
                <span key={partIndex} className={part.cls}>{part.text}</span>
              ))}
            </code>
            {line.replacement && (
              <span className="ml-1 text-[10px] font-semibold uppercase tracking-wide text-warning">
                Forces replacement
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function providerLabel(providerName: string | undefined): string {
  if (providerName === undefined || providerName === "") return "provider unknown";
  const label = providerName.split("/").pop();
  return label === undefined || label === "" ? "provider unknown" : label;
}

const actionReasonLabels = {
  replace_because_cannot_update: "Replacement required by provider",
  replace_because_tainted: "Resource is tainted",
  replace_by_request: "Replacement requested",
  replace_by_triggers: "Replacement triggered by dependency",
  delete_because_no_resource_config: "No matching resource configuration",
  delete_because_no_module: "Containing module was removed",
  delete_because_wrong_repetition: "Resource key no longer matches its configuration",
  delete_because_count_index: "Resource index is outside the configured count",
  delete_because_each_key: "Resource key is absent from for_each",
  read_because_config_unknown: "Configuration is known after apply",
  read_because_dependency_pending: "Dependency has pending changes",
};

function actionReasonLabel(reason: string): string {
  // SAFETY: unknown action reasons fall through to the underscore-replaced label below.
  return actionReasonLabels[reason as keyof typeof actionReasonLabels] ?? reason.replace(/_/g, " ");
}

function ResourceRow({ resource }: Readonly<{ resource: ResourceChange }>): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const operation = operationForResource(resource);
  const config = operationConfig[operation];
  // Plan JSON always names the resource; fall back to the final address element
  // so the structured header renders for hand-built fixtures too.
  const fallbackName = resource.name
    ?? (resource.address.split(".").pop() ?? undefined);

  const handleCopy = (event: React.MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const clipboard = Reflect.get(navigator, "clipboard") as { writeText: (value: string) => Promise<void> } | undefined;
    if (clipboard !== undefined) {
      void clipboard.writeText(resource.address);
      setCopied(true);
      setTimeout((): void => { setCopied(false); }, 1500);
    }
  };

  return (
    <details
      className="group border-b border-border last:border-b-0"
      onToggle={(event): void => { setExpanded(event.currentTarget.open); }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground/70 transition-transform group-open:rotate-90" aria-hidden="true" />
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold leading-5 ${config.className}`}>
          {"icon" in config ? (
            <config.icon className="size-3" aria-hidden="true" />
          ) : (
            <span aria-hidden="true">{config.symbol}</span>
          )}
        </span>
        {resource.change.importing !== undefined && operationForResource(resource) !== "import" && (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold leading-5 capitalize text-foreground">
            <span aria-hidden="true">&</span>
            <span>import</span>
          </span>
        )}
        {resource.previous_address !== undefined && operationForResource(resource) !== "move" && (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold leading-5 capitalize text-foreground/85">
            <span aria-hidden="true">→</span>
            <span>move</span>
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <code className="truncate font-mono text-xs font-semibold text-foreground">{resource.address}</code>
            <button
              type="button"
              aria-label={`Copy ${resource.address} address`}
              title={copied ? "Copied address!" : "Copy resource address"}
              className="rounded border border-border bg-background p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={handleCopy}
            >
              {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
            </button>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
            <span>Type: <code className="font-mono">{resource.type}</code></span>
            {resource.module_address !== undefined && (
              <span>Module: <code className="font-mono">{resource.module_address}</code></span>
            )}
            <span title={resource.provider_name}>
              Provider: <code className="font-mono">{providerLabel(resource.provider_name)}</code>
            </span>
            {resource.mode === "data" && <span>Data source</span>}
            {resource.deposed !== undefined && (
              <span>Deposed key: <code className="font-mono">{resource.deposed}</code></span>
            )}
            {resource.previous_address !== undefined && (
              <span className="flex items-center gap-1">
                Moved from <code className="font-mono">{resource.previous_address}</code>
                <ArrowRight className="inline size-3 text-muted-foreground/70" />
                <code className="font-mono font-medium text-foreground/85">{resource.address}</code>
              </span>
            )}
            {resource.change.importing !== undefined && (
              <span>
                Import ID: <code className="font-mono">
                  {resource.change.importing.unknown === true
                    ? "known after apply"
                    : resource.change.importing.id ?? "unknown"}
                </code>
              </span>
            )}
            {resource.action_reason !== undefined && resource.action_reason !== "" && (
              <span>Reason: {actionReasonLabel(resource.action_reason)}</span>
            )}
          </div>
        </div>
      </summary>
      {expanded && <AttributeDiff change={resource.change} address={resource.address} type={resource.type} name={fallbackName} />}
    </details>
  );
}

function ActionInvocations({ actions }: Readonly<{ actions: readonly ActionInvocation[] }>): React.JSX.Element {
  if (actions.length === 0) return <></>;
  return (
    <details className="border-t border-border">
      <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-foreground/85 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        Actions to invoke <span className="font-normal text-muted-foreground">({actions.length})</span>
      </summary>
      <div className="divide-y divide-border/60 border-t border-border/60">
        {actions.map((action, index): React.JSX.Element => {
          const configuredLabel = action.address
            ?? [action.type, action.name].filter((value): value is string => value !== undefined && value !== "").join(".");
          const label = configuredLabel === "" ? `Action ${index + 1}` : configuredLabel;
          const trigger = action.lifecycle_action_trigger;
          return (
            <div key={`${label}:${index}`} className="flex items-start gap-3 px-5 py-3 text-xs">
              <span className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-xs font-semibold leading-5 text-primary">invoke</span>
              <div className="min-w-0">
                <code className="break-all font-mono font-semibold text-foreground">{label}</code>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                  {action.provider_name !== undefined && (
                    <span>Provider: <code className="font-mono">{providerLabel(action.provider_name)}</code></span>
                  )}
                  {trigger?.action_trigger_event !== undefined && (
                    <span>{trigger.action_trigger_event.replace(/_/g, " ")}</span>
                  )}
                  {trigger?.triggering_resource_address !== undefined && (
                    <span>Triggered by <code className="font-mono">{trigger.triggering_resource_address}</code></span>
                  )}
                  {action.invoke_action_trigger !== undefined && <span>Explicit invocation</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function summaryCounts(resources: readonly ResourceChange[]) {
  let add = 0;
  let change = 0;
  let destroy = 0;
  let replace = 0;
  for (const resource of resources) {
    const operation = operationForResource(resource);
    if (operation === "create") add++;
    if (operation === "update") change++;
    if (operation === "delete") destroy++;
    if (operation === "replace") {
      add++;
      destroy++;
      replace++;
    }
  }
  return { add, change, destroy, replace };
}

/**
 * Render the plan resource summary as a copy-pasteable Markdown block.
 * Mirrors the on-screen summary order: import, create, change, destroy.
 */
export function planSummaryMarkdown(counts: Readonly<{
  add: number;
  change: number;
  destroy: number;
  replace: number;
  importCount: number;
}>): string {
  return [
    "## Plan summary",
    "",
    ...([
      { count: counts.importCount, label: "to import" },
      { count: counts.add, label: "to create" },
      { count: counts.change, label: "to change" },
      { count: counts.destroy, label: "to destroy" },
    ] as const)
      .filter((item): boolean => item.count > 0)
      .map((item): string => `- ${item.count} ${item.label}`),
    "",
  ].join("\n");
}

function resourceMatches(
  resource: ResourceChange,
  selectedOps: ReadonlySet<Operation>,
  query: string,
): boolean {
  if (!selectedOps.has(operationForResource(resource))) return false;
  if (query === "") return true;
  return [
    resource.address,
    resource.deposed,
    resource.previous_address,
    resource.type,
    resource.name,
    resource.module_address,
    resource.provider_name,
  ].some((value): boolean => value?.toLocaleLowerCase().includes(query) === true);
}

function OutputChanges({ outputs }: Readonly<{ outputs: readonly [string, Change][] }>): React.JSX.Element {
  if (outputs.length === 0) return <></>;
  return (
    <details className="border-t border-border">
      <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-foreground/85 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        Output changes <span className="font-normal text-muted-foreground">({outputs.length})</span>
      </summary>
      <div className="border-t border-border/60">
        {outputs.map(([name, output]): React.JSX.Element => (
          <details key={name} className="border-b border-border/60 last:border-b-0">
            <summary className="flex cursor-pointer items-center gap-2 px-5 py-2 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <span className="inline-flex items-center rounded border border-input bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium leading-5">{name}</span>
              <span className="text-muted-foreground">{(() => { const op = operationFor(output.actions); return op === "delete" ? "−" : op === "no-op" ? "·" : op === "create" ? "+" : op === "update" ? "~" : op === "read" ? "◎" : op === "replace" ? "±" : op === "import" ? "&" : op === "move" ? "→" : ""; })()}</span>
            </summary>
            <AttributeDiff change={output} address={`output.${name}`} name={name} />
          </details>
        ))}
      </div>
    </details>
  );
}

export function PlanOutput({
  runId,
  status,
  planStatus,
  onSummaryChange,
}: Readonly<{
  runId: string;
  status: string;
  planStatus?: string;
  onSummaryChange?: (summary: PlanOutputSummary | null) => void;
}>): React.JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState("");
  const [selectedOps, setSelectedOps] = useState<ReadonlySet<Operation>>(new Set(DEFAULT_SELECTED_OPS));
  const [summaryCopied, setSummaryCopied] = useState(false);
  const activeRunId = useRef(runId);
  const readyRunId = useRef<string | null>(null);

  useEffect((): (() => void) => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const shouldPoll = PLAN_PENDING_STATUSES.has(status);

    const runChanged = activeRunId.current !== runId;
    if (runChanged) {
      activeRunId.current = runId;
      readyRunId.current = null;
      setLoadState({ kind: "loading" });
      setSearch("");
      setSelectedOps(new Set(DEFAULT_SELECTED_OPS));
    }

    const load = async (): Promise<void> => {
      try {
        const data = await fetchApi(`/plans/plan-${runId}/json-output`);
        if (cancelled) return;
        const plan = parsePlanJson(data);
        if (plan === null) throw new Error("The structured plan response was invalid.");
        readyRunId.current = runId;
        setLoadState({ kind: "ready", plan });
      } catch (reason: unknown) {
        if (cancelled) return;
        if (reason instanceof ApiError && reason.status === 404 && shouldPoll) {
          setLoadState({ kind: "waiting" });
          timer = setTimeout((): void => {
            void load();
          }, POLL_INTERVAL_MS);
          return;
        }
        if (reason instanceof ApiError
          && reason.status === 404
          && PLANLESS_TERMINAL_STATUSES.has(status)
          && planStatus !== "finished") {
          setLoadState({ kind: "unavailable" });
          return;
        }
        setLoadState({
          kind: "error",
          message: reason instanceof ApiError && reason.status === 404
            ? "Plan output is not available for this run."
            : reason instanceof Error
              ? reason.message
              : "Failed to load structured plan output.",
        });
      }
    };

    if (readyRunId.current !== runId) void load();
    return (): void => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [planStatus, retry, runId, status]);

  useEffect((): void => {
    const ready = activeRunId.current === runId
      && readyRunId.current === runId
      && loadState.kind === "ready";
    onSummaryChange?.(ready
      ? {
          actionCount: loadState.plan.action_invocations?.length ?? 0,
          importCount: (loadState.plan.resource_changes ?? [])
            .filter((resource): boolean => resource.change.importing !== undefined).length,
        }
      : null);
  }, [loadState, onSummaryChange, runId]);

  if (activeRunId.current !== runId || loadState.kind === "loading") {
    return (
      <div role="status" className="flex items-center gap-2 border-t border-border px-5 py-4 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Loading structured plan output…
      </div>
    );
  }

  if (loadState.kind === "waiting") {
    return (
      <div role="status" className="flex items-start gap-3 border-t border-border bg-primary/10 px-5 py-4 text-sm text-muted-foreground">
        <Spinner className="mt-0.5 size-4 text-primary" />
        <div>
          <p className="font-medium text-foreground/85">Preparing structured plan output…</p>
          <p className="mt-0.5 text-xs">This view will update automatically when the plan is ready.</p>
        </div>
      </div>
    );
  }

  if (loadState.kind === "unavailable") {
    return (
      <div role="status" className="border-t border-border bg-muted px-5 py-4">
        <p className="text-sm font-medium text-foreground/85">Plan output was not produced for this run.</p>
      </div>
    );
  }

  if (loadState.kind === "error") {
    return (
      <div role="alert" className="border-t border-border bg-destructive/10 px-5 py-4">
        <p className="text-sm font-medium text-destructive">Could not load plan output</p>
        <p className="mt-1 text-xs text-destructive">{loadState.message}</p>
        <button
          type="button"
          className="mt-3 rounded border border-destructive/30 bg-background px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(): void => {
            setLoadState({ kind: "loading" });
            setRetry((value): number => value + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  const planJson = loadState.plan;
  const changedResources = (planJson.resource_changes ?? [])
    .filter((resource): boolean => operationForResource(resource) !== "no-op");
  const driftResources = (planJson.resource_drift ?? [])
    .filter((resource): boolean => operationForResource(resource) !== "no-op");
  const counts = summaryCounts(changedResources);
  const query = search.trim().toLocaleLowerCase();
  const filteredResources = changedResources
    .filter((resource): boolean => resourceMatches(resource, selectedOps, query));
  const filteredDrift = driftResources
    .filter((resource): boolean => resourceMatches(resource, selectedOps, query));
  const importCount = changedResources
    .filter((resource): boolean => resource.change.importing !== undefined).length;
  const moveCount = changedResources
    .filter((resource): boolean => resource.previous_address !== undefined).length;
  const outputs = Object.entries(planJson.output_changes ?? {});
  const actionInvocations = planJson.action_invocations ?? [];
  const operationSummary = [
    {
      count: importCount,
      label: "to import",
      symbol: "&",
      className: "text-foreground",
    },
    {
      count: counts.add,
      label: "to create",
      symbol: "+",
      className: "text-success",
    },
    {
      count: counts.change,
      label: "to change",
      symbol: "~",
      className: "text-primary",
    },
    {
      count: counts.destroy,
      label: "to destroy",
      symbol: "−",
      className: "text-destructive",
    },
  ].filter((item): boolean => item.count > 0);

  const opCounts = {
    create: changedResources.filter((resource): boolean => operationForResource(resource) === "create").length,
    update: changedResources.filter((resource): boolean => operationForResource(resource) === "update").length,
    delete: changedResources.filter((resource): boolean => operationForResource(resource) === "delete").length,
    replace: changedResources.filter((resource): boolean => operationForResource(resource) === "replace").length,
    read: changedResources.filter((resource): boolean => operationForResource(resource) === "read").length,
    import: importCount,
    move: moveCount,
    remove: changedResources.filter((resource): boolean => operationForResource(resource) === "remove").length,
  };

  return (
    <section aria-label="Plan output" className="border-t border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted px-5 py-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Copy plan summary as markdown"
            title={summaryCopied ? "Copied!" : "Copy plan summary as markdown"}
            className="rounded border border-border bg-background p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(): void => {
              const clipboard = Reflect.get(navigator, "clipboard") as { writeText: (value: string) => Promise<void> } | undefined;
              if (clipboard !== undefined) {
                void clipboard.writeText(planSummaryMarkdown({ ...counts, importCount })).then((): void => {
                  setSummaryCopied(true);
                  window.setTimeout((): void => { setSummaryCopied(false); }, 2_000);
                });
              }
            }}
          >
            {summaryCopied
              ? <Check className="size-3.5" aria-hidden="true" />
              : <Copy className="size-3.5" aria-hidden="true" />}
          </button>
        </div>
        <span className="text-xs text-muted-foreground">
          Terraform {planJson.terraform_version ?? "unknown"}
          {planJson.format_version !== undefined && ` · JSON ${planJson.format_version}`}
        </span>
      </div>

      <div aria-label="Resource change summary" className="flex flex-wrap gap-2 border-b border-border p-4">
        {operationSummary.length === 0 ? (
          <div aria-label="No resource changes" className="w-full rounded-md bg-muted px-3 py-2 text-sm font-medium text-muted-foreground">
            No resource changes
          </div>
        ) : operationSummary.map((item): React.JSX.Element => (
          <span
            key={item.label}
            aria-label={`${item.count} ${item.label}`}
            className={`inline-flex items-center gap-1 text-xs font-semibold leading-5 ${item.className}`}
          >
            <span aria-hidden="true">{item.symbol}</span>
            {item.count} <span className="font-normal">{item.label}</span>
          </span>
        ))}
      </div>
      {(counts.replace > 0 || moveCount > 0 || driftResources.length > 0 || actionInvocations.length > 0) && (
        <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
          {counts.replace > 0 && <span>{counts.replace} replacement{counts.replace === 1 ? "" : "s"}</span>}
          {moveCount > 0 && <span>{moveCount} move{moveCount === 1 ? "" : "s"}</span>}
          {driftResources.length > 0 && <span>{driftResources.length} drifted resource{driftResources.length === 1 ? "" : "s"}</span>}
          {actionInvocations.length > 0 && (
            <span>{actionInvocations.length} action{actionInvocations.length === 1 ? "" : "s"} to invoke</span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex flex-1 flex-wrap gap-2">
          <label className="min-w-[220px] flex-1 text-xs font-medium text-muted-foreground">
            <span className="sr-only">Filter resources by address or type</span>
            <input
              id="plan-resource-search"
              name="resource-search"
              type="search"
              autoComplete="off"
              spellCheck={false}
              value={search}
              placeholder="Filter resources by address…"
              aria-label="Filter resources by address or type"
              className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm font-normal text-foreground focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20"
              onInput={(event): void => { setSearch(event.currentTarget.value); }}
            />
          </label>
          <div
            role="group"
            aria-label="Filter by operation"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-muted-foreground"
          >
            {OPERATION_OPTIONS.map((op): React.JSX.Element => {
              const count = op === "import" ? importCount : op === "move" ? moveCount : opCounts[op as keyof typeof opCounts];
              const label = op === "remove" ? "Remove" : op === "replace" ? "Replace" : op.charAt(0).toUpperCase() + op.slice(1);
              return (
                <label key={op} className="flex cursor-pointer items-center gap-1.5 select-none hover:text-foreground">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={selectedOps.has(op)}
                    onChange={(event): void => {
                      const next = new Set(selectedOps);
                      if (event.currentTarget.checked) next.add(op);
                      else next.delete(op);
                      setSelectedOps(next);
                    }}
                  />
                  <span>
                    {label} ({count})
                  </span>
                </label>
              );
            })}
          </div>
          </div>
        <span aria-live="polite" className="text-xs text-muted-foreground">
          Showing {filteredResources.length} of {changedResources.length}
          {driftResources.length > 0 && ` · ${filteredDrift.length} of ${driftResources.length} drift`}
        </span>
      </div>

      {filteredResources.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-muted-foreground">
          {changedResources.length === 0
            ? actionInvocations.length === 0
              ? "This plan has no resource changes."
              : `This plan has no resource changes, but it will invoke ${actionInvocations.length} action${actionInvocations.length === 1 ? "" : "s"}.`
            : "No resources match these filters."}
        </p>
      ) : (
        <div aria-label={`Resource list, ${filteredResources.length} items`}>
          {filteredResources.map((resource): React.JSX.Element => (
            <ResourceRow key={`${resource.address}:${resource.deposed ?? ""}`} resource={resource} />
          ))}
        </div>
      )}

      {driftResources.length > 0 && (
        <details className="border-t border-border">
          <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-foreground/85 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            Resource drift <span className="font-normal text-muted-foreground">({filteredDrift.length})</span>
          </summary>
          {filteredDrift.length === 0 ? (
            <p className="border-t border-border/60 px-5 py-4 text-sm text-muted-foreground">
              No drifted resources match these filters.
            </p>
          ) : (
            <div className="border-t border-border/60">
              {filteredDrift.map((resource): React.JSX.Element => (
                <ResourceRow key={`${resource.address}:${resource.deposed ?? ""}`} resource={resource} />
              ))}
            </div>
          )}
        </details>
      )}

      <ActionInvocations actions={actionInvocations} />
      <OutputChanges outputs={outputs} />
    </section>
  );
}
