import { Terrence } from "./brand/Terrence";
/* eslint-disable @typescript-eslint/naming-convention -- Terraform plan JSON fields are snake_case. */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
} from "lucide-react";
import { ApiError, fetchApi } from "../lib/api";
import { ProviderIcon } from "./ProviderIcon";
import { useTerrenceEvent } from "../lib/event-provider";
import { Spinner } from "./ui/spinner";
import { OperationFilterDropdown } from "./OperationFilterDropdown";
import {
  DEFAULT_SELECTED_OPS,
  OPERATION_OPTIONS,
  operationConfig,
  operationFor,
  operationForResource,
  type Change,
  type Operation,
  type ResourceChange,
} from "../lib/plan-operations";
import { isBoolean, isNumber, isRecord, isString } from "../lib/type-guards";
import { copyTextToClipboard } from "../lib/utils";
import type { JsonObject } from "@/lib/json";

type ActionInvocation = {
  address?: string;
  type?: string;
  name?: string;
  provider_name?: string;
  lifecycle_action_trigger?: {
    triggering_resource_address?: string;
    action_trigger_event?: string;
  };
  invoke_action_trigger?: JsonObject;
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

// Degraded-mode cadence: plan readiness normally arrives over the SSE
// `plan.output.ready` event; this slow poll only covers a dead stream.
const DEGRADED_POLL_INTERVAL_MS = 30_000;
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

function isChange(value: unknown): value is Change {
  if (!isRecord(value)
    || !Array.isArray(value["actions"])
    || !value["actions"].every((action: unknown): boolean => isString(action))) return false;
  const importing = value["importing"];
  const replacePaths = value["replace_paths"];
  return (importing === undefined || (
      isRecord(importing)
      && (importing["id"] === undefined || isString(importing["id"]))
      && (importing["unknown"] === undefined || isBoolean(importing["unknown"]))
    ))
    && (replacePaths === undefined || (
      Array.isArray(replacePaths)
      && replacePaths.every((path: unknown): boolean =>
        Array.isArray(path)
        && path.every((step: unknown): boolean => isString(step) || isNumber(step)),
      )
    ));
}

function hasOptionalStringFields(value: JsonObject, fields: readonly string[]): boolean {
  return fields.every((field): boolean => value[field] === undefined || isString(value[field]));
}

function isOptionalList(value: unknown, isItem: (item: unknown) => boolean): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isItem));
}

function isOutputChangeRecord(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.values(value).every(isChange));
}

const RESOURCE_CHANGE_STRING_FIELDS = [
  "deposed",
  "module_address",
  "mode",
  "name",
  "previous_address",
  "provider_name",
  "action_reason",
];

const ACTION_INVOCATION_STRING_FIELDS = ["address", "type", "name", "provider_name"];

function isResourceChange(value: unknown): value is ResourceChange {
  return isRecord(value)
    && isString(value["address"])
    && isString(value["type"])
    && hasOptionalStringFields(value, RESOURCE_CHANGE_STRING_FIELDS)
    && isChange(value["change"]);
}

function isLifecycleTrigger(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return hasOptionalStringFields(value, ["triggering_resource_address", "action_trigger_event"]);
}

function isActionInvocation(value: unknown): value is ActionInvocation {
  if (!isRecord(value)) return false;
  if (!hasOptionalStringFields(value, ACTION_INVOCATION_STRING_FIELDS)) return false;
  if (!isLifecycleTrigger(value["lifecycle_action_trigger"])) return false;
  return value["invoke_action_trigger"] === undefined || isRecord(value["invoke_action_trigger"]);
}

function parsePlanJson(value: unknown): PlanJson | null {
  if (!isRecord(value)) return null;
  if (!isOptionalList(value["action_invocations"], isActionInvocation)) return null;
  if (!isOptionalList(value["resource_changes"], isResourceChange)) return null;
  if (!isOptionalList(value["resource_drift"], isResourceChange)) return null;
  if (!isOutputChangeRecord(value["output_changes"])) return null;
  if (!hasOptionalStringFields(value, ["terraform_version", "format_version"])) return null;
  return value;
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
  if (isNumber(key)) return Array.isArray(value) ? value[key] : undefined;
  return isRecord(value) ? value[key] : undefined;
}

function formatPath(path: readonly (string | number)[]): string {
  return path.reduce<string>((value, step): string =>
    isNumber(step)
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
      const childPath = isNumber(key)
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
  if (isString(value)) return JSON.stringify(value);
  if (isNumber(value) || isBoolean(value)) return String(value);
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

function buildArrayNode(
  key: string | number | null,
  path: string,
  before: unknown,
  after: unknown,
  beforeSensitive: unknown,
  afterSensitive: unknown,
  afterUnknown: unknown,
  equal: boolean,
): DiffNode {
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

function buildObjectNode(
  key: string | number | null,
  path: string,
  before: unknown,
  after: unknown,
  beforeSensitive: unknown,
  afterSensitive: unknown,
  afterUnknown: unknown,
  equal: boolean,
): DiffNode {
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
    return buildArrayNode(key, path, before, after, beforeSensitive, afterSensitive, afterUnknown, equal);
  }
  if (isRecord(before) || isRecord(after)) {
    return buildObjectNode(key, path, before, after, beforeSensitive, afterSensitive, afterUnknown, equal);
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

function formatActionReason(reason: string): string {
  return reason
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function semanticKeys<T>(values: readonly T[], identity: (value: T) => string): string[] {
  const occurrences = new Map<string, number>();
  return values.map((value): string => {
    const base = identity(value);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return `${base}:${occurrence}`;
  });
}

function diffLineIdentity(line: DiffLine): string {
  return JSON.stringify({
    depth: line.depth,
    path: line.path,
    parts: line.parts,
    replacement: line.replacement,
  });
}

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
  flattenChildNodes(node, context, force, depth + 1, forcesReplacement, lines, node.kind === "object" ? maxKeyWidth(node.children) : 0);
  lines.push({
    depth,
    path: node.path,
    parts: [{ text: close, cls: "text-muted-foreground/70" }],
    replacement: false,
  });
}

function pushLeafReplacementLines(
  node: Extract<DiffNode, { kind: "leaf" }>,
  depth: number,
  forcesReplacement: (path: string) => boolean,
  lines: DiffLine[],
): void {
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
}

function leafValueParts(
  node: Extract<DiffNode, { kind: "leaf" }>,
  marker: DiffMarker | null,
  keyText: string | null,
): { text: string; cls: string }[] {
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
  return parts;
}

function flattenLeafNode(
  node: Extract<DiffNode, { kind: "leaf" }>,
  context: ReadonlySet<string>,
  force: "add" | "del" | null,
  depth: number,
  keyText: string | null,
  inArray: boolean,
  forcesReplacement: (path: string) => boolean,
  lines: DiffLine[],
): void {
  if (node.unchanged && force === null && !context.has(node.path)) return;
  const marker = diffMarkerFor(node, force);
  if (inArray && marker === "mod") {
    pushLeafReplacementLines(node, depth, forcesReplacement, lines);
    return;
  }
  const parts = leafValueParts(node, marker, keyText);
  if (inArray) parts.push({ text: ",", cls: "text-muted-foreground/70" });
  lines.push({ depth, path: node.path, parts, replacement: forcesReplacement(node.path) });
}

function flattenChildNodes(
  node: Extract<DiffNode, { kind: "object" | "array" }>,
  context: ReadonlySet<string>,
  childForce: "add" | "del" | null,
  depth: number,
  forcesReplacement: (path: string) => boolean,
  lines: DiffLine[],
  width: number,
): void {
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
}

function flattenArrayForcedNode(
  node: Extract<DiffNode, { kind: "object" | "array" }>,
  context: ReadonlySet<string>,
  force: "add" | "del" | null,
  marker: DiffMarker | null,
  childForce: "add" | "del" | null,
  depth: number,
  forcesReplacement: (path: string) => boolean,
  lines: DiffLine[],
): void {
  if (marker === "mod" && force === null) {
    emitArrayItemBlock(node, "del", context, depth, forcesReplacement, lines);
    emitArrayItemBlock(node, "add", context, depth, forcesReplacement, lines);
  } else {
    emitArrayItemBlock(node, childForce ?? "del", context, depth, forcesReplacement, lines);
  }
}

function flattenContainerChildren(
  node: Extract<DiffNode, { kind: "object" | "array" }>,
  context: ReadonlySet<string>,
  childForce: "add" | "del" | null,
  depth: number,
  childDepth: number,
  width: number,
  marker: DiffMarker | null,
  keyText: string | null,
  forcesReplacement: (path: string) => boolean,
  lines: DiffLine[],
): void {
  const open = node.kind === "array" ? "[" : "{";
  const close = node.kind === "array" ? "]" : "}";
  const keyedParts: { text: string; cls: string }[] = [];
  if (marker !== null) keyedParts.push({ text: `${diffMarkerText[marker]} `, cls: diffMarkerClasses[marker] });
  keyedParts.push({ text: keyText ?? "", cls: "text-foreground" });
  keyedParts.push({ text: ` = ${open}`, cls: "text-muted-foreground/70" });
  lines.push({ depth, path: node.path, parts: keyedParts, replacement: forcesReplacement(node.path) });
  flattenChildNodes(node, context, childForce, childDepth, forcesReplacement, lines, width);
  lines.push({ depth, path: node.path, parts: [{ text: close, cls: "text-muted-foreground/70" }], replacement: false });
}

function flattenContainerNode(
  node: Extract<DiffNode, { kind: "object" | "array" }>,
  context: ReadonlySet<string>,
  force: "add" | "del" | null,
  depth: number,
  keyText: string | null,
  inArray: boolean,
  forcesReplacement: (path: string) => boolean,
  lines: DiffLine[],
): void {
  const isRoot = node.key === null && keyText === null && !inArray;
  if (!isRoot && node.unchanged && force === null) return;
  const marker = diffMarkerFor(node, force);
  const childForce: "add" | "del" | null = force ?? (node.added ? "add" : node.removed ? "del" : null);
  const childDepth = depth + 1;
  const width = node.kind === "object" ? maxKeyWidth(node.children) : 0;

  if (isRoot) {
    flattenChildNodes(node, context, childForce, depth, forcesReplacement, lines, width);
    return;
  }

  if (inArray) {
    flattenArrayForcedNode(node, context, force, marker, childForce, depth, forcesReplacement, lines);
    return;
  }

  flattenContainerChildren(node, context, childForce, depth, childDepth, width, marker, keyText, forcesReplacement, lines);
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
    flattenLeafNode(node, context, force, depth, keyText, inArray, forcesReplacement, lines);
    return;
  }

  flattenContainerNode(node, context, force, depth, keyText, inArray, forcesReplacement, lines);
}

export function AttributeDiff({
  change,
  address,
  type,
  name,
  actionReason,
}: Readonly<{
  change: Change;
  address: string;
  type?: string | undefined;
  name?: string | undefined;
  actionReason?: string | undefined;
}>): React.JSX.Element {
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

  const lineKeys = semanticKeys(lines, diffLineIdentity);
  return (
    <div aria-label={`Attribute changes for ${address}`} className="overflow-x-auto border-t border-border bg-muted px-4 pb-3">
      <div className="min-w-[560px] py-2 font-mono text-xs leading-5">
        {lines.map((line, lineIndex): React.JSX.Element => {
          const partKeys = semanticKeys(line.parts, (part): string => JSON.stringify(part));
          return (
            <div key={lineKeys[lineIndex]} className="flex items-baseline whitespace-pre">
              <code>
                <span className="text-muted-foreground/70">{" ".repeat(line.depth * 2)}</span>
                {line.parts.map((part, partIndex): React.JSX.Element => (
                  <span key={partKeys[partIndex]} className={part.cls}>{part.text}</span>
                ))}
              </code>
              {line.replacement && (
                <span className="ml-1 text-2xs font-semibold uppercase tracking-wide text-warning">
                  <span>Forces replacement</span>
                  {actionReason !== undefined && actionReason !== "" && (
                    <span>{` · ${formatActionReason(actionReason)}`}</span>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function resourceIdentity(resource: ResourceChange): string {
  return `${resource.address}:${resource.deposed ?? ""}`;
}

function ResourceRow({ resource }: Readonly<{ resource: ResourceChange }>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedResetTimerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
  const operation = operationForResource(resource);
  const config = operationConfig[operation];
  useEffect((): (() => void) => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      if (copiedResetTimerRef.current !== undefined) window.clearTimeout(copiedResetTimerRef.current);
    };
  }, []);
  // Plan JSON always names the resource; fall back to the final address element
  // so the structured header renders for hand-built fixtures too.
  const fallbackName = resource.name
    ?? (resource.address.split(".").pop() ?? undefined);

  const handleCopy = (event: React.MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    void copyTextToClipboard(resource.address).then((didCopy): void => {
      if (!didCopy || !mountedRef.current) return;
      setCopied(true);
      if (copiedResetTimerRef.current !== undefined) window.clearTimeout(copiedResetTimerRef.current);
      copiedResetTimerRef.current = window.setTimeout((): void => {
        copiedResetTimerRef.current = undefined;
        setCopied(false);
      }, 1500);
    });
  };

  return (
    <details
      className="group/resource border-b border-border last:border-b-0"
      onToggle={(event): void => { setOpen(event.currentTarget.open); }}
    >
      <summary
        className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
      >
        <ChevronRight className="size-4 shrink-0 rotate-0 text-muted-foreground/70 transition-transform group-open/resource:rotate-90" aria-hidden="true" />
        <span className={`inline-flex shrink-0 items-center justify-center text-sm font-bold leading-none ${config.className}`}>
          {"icon" in config ? (
            <config.icon className="size-3.5" aria-hidden="true" />
          ) : (
            <span aria-hidden="true">{config.symbol}</span>
          )}
        </span>
        <ProviderIcon providerName={resource.provider_name} size={22} />
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
            <code
              className="truncate font-mono text-xs font-semibold text-foreground"
              title={resource.provider_name ?? undefined}
            >
              {resource.address}
            </code>
            <button
              type="button"
              aria-label={`Copy ${resource.address} address`}
              title={copied ? "Copied address!" : "Copy resource address"}
              className="size-6 shrink-0 rounded p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/resource:opacity-100"
              onClick={handleCopy}
            >
              {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
            </button>
          </div>

        </div>
      </summary>
      {operation === "unsupported" && <p role="alert" className="px-4 py-2 text-sm text-warning">Unsupported operation: review the CLI plan before approval. Actions: {resource.change.actions.join(" → ") || "missing"}.</p>}
      {operation === "remove" && <p className="px-4 py-2 text-sm text-muted-foreground">Remove from state without destroying the object.</p>}
      {open && <AttributeDiff
        change={resource.change}
        address={resource.address}
        type={resource.type}
        name={fallbackName}
        actionReason={resource.action_reason}
      />}
    </details>
  );
}

function actionInvocationIdentity(action: ActionInvocation): string {
  return JSON.stringify({
    address: action.address,
    type: action.type,
    name: action.name,
    provider_name: action.provider_name,
    lifecycle_action_trigger: action.lifecycle_action_trigger,
    invoke_action_trigger: action.invoke_action_trigger,
  });
}

function ActionInvocations({ actions }: Readonly<{ actions: readonly ActionInvocation[] }>): React.JSX.Element {
  if (actions.length === 0) return <></>;
  const actionKeys = semanticKeys(actions, actionInvocationIdentity);
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
            <div key={actionKeys[index]} className="flex items-start gap-3 px-5 py-3 text-xs">
              <span className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-xs font-semibold leading-5 text-primary">invoke</span>
              <div className="min-w-0">
                <code className="break-all font-mono font-semibold text-foreground">{label}</code>
                <div className="mt-1 flex flex-wrap gap-x-3 text-2xs text-muted-foreground">
                  {action.provider_name !== undefined && (
                    <span className="inline-flex items-center gap-1.5"><ProviderIcon providerName={action.provider_name} size={14} /><code className="font-mono text-foreground/70">{(action.provider_name.split("/").pop() ?? action.provider_name)}</code></span>
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
  removeCount?: number;
  unsupportedCount?: number;
  moveCount?: number;
}>): string {
  return [
    "## Plan summary",
    "",
    ...([
      { count: counts.importCount, label: "to import" },
      { count: counts.add, label: "to create" },
      { count: counts.change, label: "to change" },
      { count: counts.destroy, label: "to destroy" },
      { count: counts.removeCount ?? 0, label: "to remove from state" },
      { count: counts.unsupportedCount ?? 0, label: "unsupported operations — review the CLI plan before approval" },
      { count: counts.moveCount ?? 0, label: "to move" },
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
  const primaryOp = operationForResource(resource);
  const matchesOp = selectedOps.has(primaryOp)
    || (resource.previous_address !== undefined && selectedOps.has("move"))
    || (resource.change.importing !== undefined && selectedOps.has("import"));
  if (!matchesOp) return false;
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
              <span className="inline-flex items-center rounded border border-input bg-muted px-1.5 py-0.5 font-mono text-2xs font-medium leading-5">{name}</span>
              <span className="text-muted-foreground">{(() => { const op = operationFor(output.actions); return op === "delete" ? "−" : op === "no-op" ? "·" : op === "create" ? "+" : op === "update" ? "~" : op === "read" ? "◎" : op === "replace" ? "±" : op === "import" ? "&" : op === "move" ? "→" : ""; })()}</span>
            </summary>
            <AttributeDiff change={output} address={`output.${name}`} name={name} />
          </details>
        ))}
      </div>
    </details>
  );
}

function settleLoadFailure(
  reason: unknown,
  shouldPoll: boolean,
  planStatus: string | undefined,
  status: string,
  setLoadState: (state: LoadState) => void,
  scheduleDegraded: () => void,
): void {
  if (reason instanceof ApiError && reason.status === 404 && shouldPoll) {
    setLoadState({ kind: "waiting" });
    scheduleDegraded();
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

function PlanLoadingState({ planStatus }: Readonly<{ planStatus?: string | undefined }>): React.JSX.Element {
  if (planStatus === "running") return <></>;
  return (
    <div role="status" className="flex items-center gap-2 border-t border-border px-5 py-4 text-sm text-muted-foreground">
      <Spinner className="size-4" />
      Loading structured plan output…
    </div>
  );
}

function PlanWaitingState({ planStatus }: Readonly<{ planStatus?: string | undefined }>): React.JSX.Element {
  if (planStatus === "running") return <></>;
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

function PlanUnavailableState(): React.JSX.Element {
  return (
    <div role="status" className="border-t border-border bg-muted px-5 py-4">
      <p className="text-sm font-medium text-foreground/85">Plan output was not produced for this run.</p>
    </div>
  );
}

function PlanErrorState({ message, onRetry }: Readonly<{ message: string; onRetry: () => void }>): React.JSX.Element {
  return (
    <div role="alert" className="border-t border-border bg-destructive/10 px-5 py-4">
      <p className="text-sm font-medium text-destructive">Could not load plan output</p>
      <p className="mt-1 text-xs text-destructive">{message}</p>
      <button
        type="button"
        className="mt-3 rounded border border-destructive/30 bg-background px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onRetry}
      >
        Try again
      </button>
    </div>
  );
}

type PlanDerived = {
  planJson: PlanJson;
  changedResources: ResourceChange[];
  driftResources: ResourceChange[];
  counts: { add: number; change: number; destroy: number; replace: number };
  filteredResources: ResourceChange[];
  filteredDrift: ResourceChange[];
  importCount: number;
  moveCount: number;
  outputs: [string, Change][];
  actionInvocations: ActionInvocation[];
  operationSummary: { count: number; label: string; symbol: string; className: string }[];
  opCounts: {
    create: number;
    update: number;
    delete: number;
    replace: number;
    read: number;
    import: number;
    move: number;
    remove: number;
    unsupported: number;
  };
};

function operationForSummaryLabel(label: string): Operation | null {
  if (label === "to remove from state") return "remove";
  if (label === "unsupported operations") return "unsupported";
  if (label === "to move") return "move";
  if (label === "to import") return "import";
  if (label === "to create") return "create";
  if (label === "to change") return "update";
  if (label === "to destroy") return "delete";
  return null;
}

function PlanOperationSummary({
  operationSummary,
  onSelect,
}: Readonly<{
  operationSummary: PlanDerived["operationSummary"];
  onSelect: (label: string) => void;
}>): React.JSX.Element {
  return (
    <div aria-label="Resource change summary" className="flex flex-wrap gap-2 border-b border-border p-4">
      {operationSummary.length === 0 ? (
        <div aria-label="No resource changes" className="w-full rounded-md bg-muted px-3 py-2 text-sm font-medium text-muted-foreground">
          No resource changes
        </div>
      ) : operationSummary.map((item): React.JSX.Element => (
        <button
          type="button"
          key={item.label}
          aria-label={`${item.count} ${item.label}`}
          aria-controls="plan-resource-list"
          title="Show these changes"
          className={`inline-flex items-center gap-1 rounded px-1 text-xs font-semibold leading-5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${item.className}`}
          onClick={(): void => {
            onSelect(item.label);
          }}
        >
          <span aria-hidden="true">{item.symbol}</span>
          {item.count} <span className="font-normal">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

function PlanExtraCounts({
  replaceCount,
  moveCount,
  driftCount,
  actionCount,
}: Readonly<{
  replaceCount: number;
  moveCount: number;
  driftCount: number;
  actionCount: number;
}>): React.JSX.Element | null {
  if (replaceCount === 0 && moveCount === 0 && driftCount === 0 && actionCount === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
      {replaceCount > 0 && <span>{replaceCount} replacement{replaceCount === 1 ? "" : "s"}</span>}
      {moveCount > 0 && <span>{moveCount} move{moveCount === 1 ? "" : "s"}</span>}
      {driftCount > 0 && <span>{driftCount} drifted resource{driftCount === 1 ? "" : "s"}</span>}
      {actionCount > 0 && (
        <span>{actionCount} action{actionCount === 1 ? "" : "s"} to invoke</span>
      )}
    </div>
  );
}

function PlanResourceList({
  filteredResources,
  changedResources,
  driftResources,
  actionInvocations,
  outputs,
  planStatus,
}: Readonly<{
  filteredResources: PlanDerived["filteredResources"];
  changedResources: PlanDerived["changedResources"];
  driftResources: PlanDerived["driftResources"];
  actionInvocations: PlanDerived["actionInvocations"];
  outputs: PlanDerived["outputs"];
  planStatus?: string | undefined;
}>): React.JSX.Element {
  if (filteredResources.length !== 0) {
    return (
      <div id="plan-resource-list" aria-label={`Resource list, ${filteredResources.length} items`}>
        {filteredResources.map((resource): React.JSX.Element => (
          <ResourceRow key={resourceIdentity(resource)} resource={resource} />
        ))}
      </div>
    );
  }
  const showMascot = changedResources.length === 0
    && driftResources.length === 0
    && actionInvocations.length === 0
    && outputs.length === 0
    && planStatus === "finished";
  return (
    <div className="px-5 py-6 text-center text-sm text-muted-foreground">
      {showMascot && <Terrence pose="healthy" detail="small" className="mx-auto mb-3 w-32" />}
      <p>{changedResources.length === 0
        ? actionInvocations.length === 0
          ? "This plan has no resource changes."
          : `This plan has no resource changes, but it will invoke ${actionInvocations.length} action${actionInvocations.length === 1 ? "" : "s"}.`
        : "No resources match these filters."}</p>
    </div>
  );
}

function PlanDriftSection({
  driftResources,
  filteredDrift,
}: Readonly<{
  driftResources: PlanDerived["driftResources"];
  filteredDrift: PlanDerived["filteredDrift"];
}>): React.JSX.Element | null {
  if (driftResources.length === 0) return null;
  return (
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
            <ResourceRow key={resourceIdentity(resource)} resource={resource} />
          ))}
        </div>
      )}
    </details>
  );
}

function PlanSummaryHeader({
  planJson,
  summaryCopied,
  onCopySummary,
}: Readonly<{
  planJson: PlanJson;
  summaryCopied: boolean;
  onCopySummary: () => void;
}>): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted px-5 py-2.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Copy plan summary as markdown"
          title={summaryCopied ? "Copied!" : "Copy plan summary as markdown"}
          className="rounded border border-border bg-background p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onCopySummary}
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
  const summaryCopiedResetTimerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
  const activeRunId = useRef(runId);
  const readyRunId = useRef<string | null>(null);
  const degradedTimerRef = useRef<number | undefined>(undefined);
  // The latest effect's load, so the SSE handler always reloads the current
  // run even while the effect is mid-commit.
  const loadRef = useRef<() => void>(() => {});

  useEffect((): (() => void) => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      if (summaryCopiedResetTimerRef.current !== undefined) window.clearTimeout(summaryCopiedResetTimerRef.current);
    };
  }, []);

  useEffect((): (() => void) => {
    let cancelled = false;
    const shouldPoll = PLAN_PENDING_STATUSES.has(status);

    const runChanged = activeRunId.current !== runId;
    if (runChanged) {
      activeRunId.current = runId;
      readyRunId.current = null;
      setLoadState({ kind: "loading" });
      setSearch("");
      setSelectedOps(new Set(DEFAULT_SELECTED_OPS));
    }

    const scheduleDegraded = (): void => {
      if (degradedTimerRef.current !== undefined) window.clearTimeout(degradedTimerRef.current);
      degradedTimerRef.current = window.setTimeout((): void => {
        degradedTimerRef.current = undefined;
        if (!cancelled) void load();
      }, DEGRADED_POLL_INTERVAL_MS);
    };

    const load = async (): Promise<void> => {
      // A load supersedes any pending degraded retry: its result decides the
      // next schedule, so a stale timer must not double-fetch afterwards.
      if (degradedTimerRef.current !== undefined) {
        window.clearTimeout(degradedTimerRef.current);
        degradedTimerRef.current = undefined;
      }
      try {
        const data = await fetchApi(`/plans/plan-${runId}/json-output`);
        if (cancelled) return;
        if (data === null) {
          // 204: plan JSON supported but the plan has not completed (the
          // reference format contract). Wait for the SSE event; the degraded timer is the
          // safety net if the stream is down.
          if (shouldPoll) {
            setLoadState({ kind: "waiting" });
            scheduleDegraded();
          } else {
            setLoadState({ kind: "unavailable" });
          }
          return;
        }
        const plan = parsePlanJson(data);
        if (plan === null) throw new Error("The structured plan response was invalid.");
        readyRunId.current = runId;
        setLoadState({ kind: "ready", plan });
      } catch (reason: unknown) {
        if (cancelled) return;
        settleLoadFailure(reason, shouldPoll, planStatus, status, setLoadState, scheduleDegraded);
      }
    };
    loadRef.current = (): void => { void load(); };

    if (readyRunId.current !== runId) void load();
    return (): void => {
      cancelled = true;
      if (degradedTimerRef.current !== undefined) {
        window.clearTimeout(degradedTimerRef.current);
        degradedTimerRef.current = undefined;
      }
    };
  }, [planStatus, retry, runId, status]);

  // The worker publishes plan.output.ready once the artifact is persisted:
  // fetch it once instead of polling every second while planning runs.
  useTerrenceEvent("plan.output.ready", (data): boolean => data["run-id"] === runId, (): void => {
    if (readyRunId.current === runId) return;
    loadRef.current();
  });

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

  const derived = useMemo((): PlanDerived | null => {
    if (loadState.kind !== "ready") return null;
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
    const outputs = Object.entries(planJson.output_changes ?? {})
      .filter(([, change]): boolean => change.actions.some((action): boolean => action !== "no-op"));
    const actionInvocations = planJson.action_invocations ?? [];
    const removeCount = changedResources.filter((resource): boolean => operationForResource(resource) === "remove").length;
    const unsupportedCount = changedResources.filter((resource): boolean => operationForResource(resource) === "unsupported").length;
    const operationSummary = [
      { count: removeCount, label: "to remove from state", symbol: "−", className: "text-muted-foreground" },
      { count: unsupportedCount, label: "unsupported operations", symbol: "?", className: "text-warning" },
      { count: moveCount, label: "to move", symbol: "→", className: "text-foreground" },
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
      remove: removeCount,
      unsupported: unsupportedCount,
    };
    return {
      planJson,
      changedResources,
      driftResources,
      counts,
      filteredResources,
      filteredDrift,
      importCount,
      moveCount,
      outputs,
      actionInvocations,
      operationSummary,
      opCounts,
    };
  }, [loadState, search, selectedOps]);
  if (activeRunId.current !== runId || loadState.kind === "loading") {
    return <PlanLoadingState planStatus={planStatus} />;
  }

  if (loadState.kind === "waiting") {
    return <PlanWaitingState planStatus={planStatus} />;
  }

  if (loadState.kind === "unavailable") {
    return <PlanUnavailableState />;
  }

  if (loadState.kind === "error") {
    return (
      <PlanErrorState
        message={loadState.message}
        onRetry={(): void => {
          setLoadState({ kind: "loading" });
          setRetry((value): number => value + 1);
        }}
      />
    );
  }

  if (derived === null) return <></>;

  const {
    planJson,
    changedResources,
    driftResources,
    counts,
    filteredResources,
    filteredDrift,
    importCount,
    moveCount,
    outputs,
    actionInvocations,
    operationSummary,
    opCounts,
  } = derived;

  const handleSelectOperation = (label: string): void => {
    const operation = operationForSummaryLabel(label);
    if (operation !== null) {
      // Replacement resources contribute to both the create and
      // destroy summary counts, so keep them in either summary
      // filter as well.
      setSelectedOps(new Set(
        operation === "create" || operation === "delete"
          ? [operation, "replace"]
          : [operation],
      ));
    }
    document.getElementById("plan-resource-list")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleCopySummary = (): void => {
    void copyTextToClipboard(planSummaryMarkdown({ ...counts, importCount, moveCount, removeCount: opCounts.remove, unsupportedCount: opCounts.unsupported })).then((didCopy): void => {
      if (!didCopy || !mountedRef.current) return;
      setSummaryCopied(true);
      if (summaryCopiedResetTimerRef.current !== undefined) window.clearTimeout(summaryCopiedResetTimerRef.current);
      summaryCopiedResetTimerRef.current = window.setTimeout((): void => {
        summaryCopiedResetTimerRef.current = undefined;
        setSummaryCopied(false);
      }, 2_000);
    });
  };

  return (
    <section aria-label="Plan output" className="border-t border-border">
      <PlanSummaryHeader planJson={planJson} summaryCopied={summaryCopied} onCopySummary={handleCopySummary} />

      <PlanOperationSummary operationSummary={operationSummary} onSelect={handleSelectOperation} />
      <PlanExtraCounts replaceCount={counts.replace} moveCount={moveCount} driftCount={driftResources.length} actionCount={actionInvocations.length} />

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
          <OperationFilterDropdown
            options={OPERATION_OPTIONS}
            defaultOps={DEFAULT_SELECTED_OPS}
            selectedOps={selectedOps}
            onChange={setSelectedOps}
            opCounts={opCounts}
          />
        </div>
        <span aria-live="polite" className="text-xs text-muted-foreground">
          Showing {filteredResources.length} of {changedResources.length}
          {driftResources.length > 0 && ` · ${filteredDrift.length} of ${driftResources.length} drift`}
        </span>
      </div>

      <PlanResourceList
        filteredResources={filteredResources}
        changedResources={changedResources}
        driftResources={driftResources}
        actionInvocations={actionInvocations}
        outputs={outputs}
        planStatus={planStatus}
      />

      <PlanDriftSection driftResources={driftResources} filteredDrift={filteredDrift} />

      <ActionInvocations actions={actionInvocations} />
      <OutputChanges outputs={outputs} />
    </section>
  );
}
