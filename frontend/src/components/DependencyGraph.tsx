import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeHandle,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  ArrowRight,
  Box,
  Boxes,
  Check,
  ChevronRight,
  Container,
  Copy,
  Database,
  GitBranch,
  Globe,
  HardDrive,
  Network,
  Send,
  Server,
  Shield,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn, formatDateTime } from "@/lib/utils";

export type DependencyGraphResource = Readonly<{
  address: string;
  dependencies: readonly string[];
}>;

export type ResourceDetails = Readonly<{
  provider?: string;
  "provider-type"?: string;
  module?: string;
  "updated-at"?: string;
}>;

const NODE_WIDTH = 232;
const NODE_HEIGHT = 56;
const COLUMN_GAP = 84;
const ROW_GAP = 30;
const PADDING = 36;

const PROVIDER_COLORS = {
  aws: "28 84% 46%",
  awscc: "28 84% 46%",
  azurerm: "207 88% 42%",
  azuread: "207 88% 42%",
  google: "217 89% 53%",
  "google-beta": "217 89% 53%",
  github: "262 80% 55%",
  kubernetes: "215 100% 47%",
  helm: "265 89% 55%",
  random: "174 72% 30%",
  local: "220 9% 42%",
  null: "220 9% 42%",
  terraform: "261 69% 50%",
  cloudflare: "24 97% 50%",
  docker: "213 80% 45%",
  vault: "263 60% 42%",
  datadog: "262 73% 52%",
  statuscake: "150 60% 35%",
};
const DEFAULT_PROVIDER_COLOR = "239 84% 60%";

const ICON_RULES: readonly Readonly<{ pattern: RegExp; icon: LucideIcon }>[] = [
  { pattern: /(cloudfront|cdn|domain|dns|route53|zone|certificate|acm)/, icon: Globe },
  { pattern: /(vpc|subnet|security_group|internet_gateway|nat_gateway|route_table|route|network|transit_gateway|peering|firewall|load_balancer|elb|listener|target_group|eni|eip)/, icon: Network },
  { pattern: /(instance|launch_template|compute|virtual_machine|scale_set|worker|host)/, icon: Server },
  { pattern: /(s3|bucket|object|storage)/, icon: Boxes },
  { pattern: /(volume|disk|ebs|filesystem)/, icon: HardDrive },
  { pattern: /(rds|database|dynamodb|elasticache|aurora|redshift|sql|bigquery|cosmos|documentdb|mongo|postgres|mysql)/, icon: Database },
  { pattern: /(lambda|function)/, icon: Zap },
  { pattern: /(iam|role|policy|kms|secret|key|vault|waf|guardduty)/, icon: Shield },
  { pattern: /(sqs|sns|queue|event|stream|kafka|pubsub|notification|topic)/, icon: Send },
  { pattern: /(kubernetes|helm|eks|gke|aks|container|ecr|registry|docker)/, icon: Container },
  { pattern: /(github|git|repo)/, icon: GitBranch },
];

type GraphModel = Readonly<{
  nodes: readonly DependencyGraphResource[];
  edges: readonly Readonly<{ from: string; to: string }>[];
  dependents: ReadonlyMap<string, readonly string[]>;
  positions: ReadonlyMap<string, Readonly<{ x: number; y: number }>>;
}>;

type ResourceNodeData = {
  address: string;
  provider: string;
  providerType: string;
  module: string;
  updatedAt: string;
  color: string;
  icon: LucideIcon;
  dependencies: readonly string[];
  dependents: readonly string[];
};

type ResourceFlowNode = Node<ResourceNodeData, "resource">;
type FlowEdge = Edge<Readonly<{ from: string; to: string }>>;

type Selection =
  | Readonly<{ kind: "node"; address: string }>
  | Readonly<{ kind: "edge"; from: string; to: string }>
  | null;

function buildGraphModel(resources: readonly DependencyGraphResource[]): GraphModel | null {
  const resourcesByAddress = new Map<string, DependencyGraphResource>();
  resources.forEach((resource): void => {
    const existing = resourcesByAddress.get(resource.address);
    resourcesByAddress.set(resource.address, existing === undefined
      ? resource
      : {
          address: resource.address,
          dependencies: [...new Set([...existing.dependencies, ...resource.dependencies])],
        });
  });
  const nodes = [...resourcesByAddress.values()].map((resource): DependencyGraphResource => ({
    ...resource,
    dependencies: resource.dependencies.filter((dependency): boolean => resourcesByAddress.has(dependency)),
  }));
  const nodeAddresses = new Set(nodes.map((node): string => node.address));
  const edges = nodes.flatMap((node): readonly Readonly<{ from: string; to: string }>[] => node.dependencies
    .filter((dependency): boolean => nodeAddresses.has(dependency))
    .map((dependency) => ({ from: dependency, to: node.address })));
  if (nodes.length < 2 || edges.length === 0) return null;

  const levels = new Map<string, number>();
  const nodesByAddress = new Map(nodes.map((node): [string, DependencyGraphResource] => [node.address, node]));
  const visiting = new Set<string>();
  const levelFor = (address: string): number => {
    const cached = levels.get(address);
    if (cached !== undefined) return cached;
    if (visiting.has(address)) return 0;
    visiting.add(address);
    const node = nodesByAddress.get(address);
    const level = node === undefined
      ? 0
      : Math.max(0, ...node.dependencies.map((dependency): number => levelFor(dependency) + 1));
    visiting.delete(address);
    levels.set(address, level);
    return level;
  };
  nodes.forEach((node): void => { levelFor(node.address); });

  const byLevel = new Map<number, DependencyGraphResource[]>();
  nodes.forEach((node): void => {
    const level = levels.get(node.address) ?? 0;
    const column = byLevel.get(level) ?? [];
    column.push(node);
    byLevel.set(level, column);
  });

  const tallest = Math.max(...[...byLevel.values()].map((column): number => column.length));
  const tallestHeight = tallest * NODE_HEIGHT + (tallest - 1) * ROW_GAP;
  const positions = new Map<string, Readonly<{ x: number; y: number }>>();
  [...byLevel.entries()].forEach(([level, column]): void => {
    column.sort((left, right): number => left.address.localeCompare(right.address));
    const columnHeight = column.length * NODE_HEIGHT + (column.length - 1) * ROW_GAP;
    column.forEach((node, index): void => {
      positions.set(node.address, {
        x: PADDING + level * (NODE_WIDTH + COLUMN_GAP),
        y: PADDING + (tallestHeight - columnHeight) / 2 + index * (NODE_HEIGHT + ROW_GAP),
      });
    });
  });

  const dependents = new Map<string, string[]>();
  edges.forEach((edge): void => {
    const list = dependents.get(edge.from) ?? [];
    list.push(edge.to);
    dependents.set(edge.from, list);
  });

  return { nodes, edges, dependents, positions };
}

function shortAddress(address: string): string {
  const segments = address.split(".");
  return segments.length > 2 ? `…${segments.slice(-2).join(".")}` : address;
}

function typeSegmentOf(address: string): string {
  const segments = address.split(".");
  const start = segments[0] === "module" ? 2 : 0;
  const candidate = segments[start] === "data" ? segments[start + 1] : segments[start];
  return candidate ?? address;
}

function providerFrom(address: string, details: ResourceDetails | undefined): string {
  const provider = details?.provider;
  if (provider !== undefined && provider !== "") return provider;
  const prefix = typeSegmentOf(address).split("_")[0] ?? "";
  return prefix !== "" ? prefix : "terraform";
}

function providerTypeFrom(address: string, details: ResourceDetails | undefined): string {
  const providerType = details?.["provider-type"];
  if (providerType !== undefined && providerType !== "") return providerType;
  return typeSegmentOf(address);
}

function colorFor(provider: string): string {
  // SAFETY: unknown provider names fall through to DEFAULT_PROVIDER_COLOR below.
  return PROVIDER_COLORS[provider as keyof typeof PROVIDER_COLORS] ?? DEFAULT_PROVIDER_COLOR;
}

function iconFor(providerType: string): LucideIcon {
  for (const rule of ICON_RULES) {
    if (rule.pattern.test(providerType)) return rule.icon;
  }
  return Box;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return formatDateTime(date);
}

function toFlowNodes(
  model: GraphModel,
  details: Readonly<Record<string, ResourceDetails>> | undefined,
): ResourceFlowNode[] {
  return model.nodes.map((node): ResourceFlowNode => {
    const info = details?.[node.address];
    const provider = providerFrom(node.address, info);
    const handles: NodeHandle[] = [
      { x: 0, y: 0, type: "target", position: Position.Left, width: NODE_WIDTH, height: NODE_HEIGHT },
      { x: 0, y: 0, type: "source", position: Position.Right, width: NODE_WIDTH, height: NODE_HEIGHT },
    ];
    return {
      id: node.address,
      type: "resource",
      position: model.positions.get(node.address) ?? { x: 0, y: 0 },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      handles,
      data: {
        address: node.address,
        provider,
        providerType: providerTypeFrom(node.address, info),
        module: info?.module ?? "root",
        updatedAt: info?.["updated-at"] ?? "",
        color: colorFor(provider),
        icon: iconFor(providerTypeFrom(node.address, info)),
        dependencies: node.dependencies,
        dependents: model.dependents.get(node.address) ?? [],
      },
    };
  });
}

function toFlowEdges(model: GraphModel, dark: boolean): FlowEdge[] {
  const stroke = dark ? "hsl(220 10% 62%)" : "hsl(220 9% 45%)";
  return model.edges.map((edge): FlowEdge => ({
    id: `${edge.from}->${edge.to}`,
    source: edge.from,
    target: edge.to,
    type: "default",
    animated: true,
    interactionWidth: 22,
    data: { from: edge.from, to: edge.to },
    style: { stroke, strokeWidth: 1.5, opacity: 0.6 },
    markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: stroke },
  }));
}

function useDarkMode(): boolean {
  const [dark, setDark] = useState((): boolean =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"));
  useEffect((): (() => void) => {
    const root = document.documentElement;
    const observer = new MutationObserver((): void => {
      setDark(root.classList.contains("dark"));
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return (): void => { observer.disconnect(); };
  }, []);
  return dark;
}

function ResourceNodeComponent({ data, selected }: NodeProps<ResourceFlowNode>): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex h-full w-full items-center gap-2.5 rounded-lg border border-l-[3px] border-border bg-card py-2.5 pl-2.5 pr-3 shadow-sm transition-shadow duration-150",
        selected ? "border-ring shadow-md ring-2 ring-ring/25" : "hover:shadow-md",
      )}
      style={{ borderLeftColor: `hsl(${data.color})` }}
    >
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-md"
        style={{ backgroundColor: `hsl(${data.color} / 0.12)`, color: `hsl(${data.color})` }}
      >
        {createElement(data.icon, { "aria-hidden": true, className: "size-4" })}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs font-medium text-foreground" title={data.address}>
          {shortAddress(data.address)}
        </span>
        <span className="mt-0.5 block truncate text-[11px] leading-none text-muted-foreground">
          {data.providerType}
          {data.module !== "root" ? ` · ${data.module}` : ""}
        </span>
      </span>
      <Handle type="target" position={Position.Left} isConnectable={false} className="!opacity-0" />
      <Handle type="source" position={Position.Right} isConnectable={false} className="!opacity-0" />
    </div>
  );
}

function SectionLabel({ children, className }: Readonly<{ children: React.ReactNode; className?: string }>): React.JSX.Element {
  return (
    <p className={cn("text-[11px] font-semibold uppercase tracking-wider text-muted-foreground", className)}>
      {children}
    </p>
  );
}

function StatTile({ label, value }: Readonly<{ label: string; value: number }>): React.JSX.Element {
  return (
    <div className="rounded-lg border px-3 py-2.5">
      <p className="text-lg font-semibold leading-none tabular-nums text-foreground">{value}</p>
      <p className="mt-1.5 text-[11px] leading-none text-muted-foreground">{label}</p>
    </div>
  );
}

function AttributeRow({ label, value }: Readonly<{ label: string; value: string }>): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all text-right font-mono text-xs text-foreground">{value}</dd>
    </div>
  );
}

function RelationshipList({
  items,
  emptyLabel,
  onPick,
}: Readonly<{
  items: readonly string[];
  emptyLabel: string;
  onPick: (address: string) => void;
}>): React.JSX.Element {
  if (items.length === 0) {
    return <p className="rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <ul className="space-y-0.5">
      {items.map((item): React.JSX.Element => (
        <li key={item}>
          <button
            type="button"
            onClick={(): void => { onPick(item); }}
            className="group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground group-hover:text-primary" title={item}>
              {item}
            </span>
            <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function NodeDetailsPanel({
  node,
  onClose,
  onFocusNode,
}: Readonly<{
  node: ResourceFlowNode;
  onClose: () => void;
  onFocusNode: (address: string) => void;
}>): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((): void => {
    void navigator.clipboard.writeText(node.id).then((): void => {
      setCopied(true);
      window.setTimeout((): void => { setCopied(false); }, 1200);
    }).catch((): void => { /* Clipboard unavailable. */ });
  }, [node.id]);

  return (
    <aside
      aria-label="Resource details"
      className="absolute inset-y-0 right-0 z-20 flex w-80 flex-col border-l border-border bg-card shadow-[-8px_0_28px_-6px_rgba(0,0,0,0.3)] animate-in fade-in slide-in-from-right-4 duration-200"
    >
      <header className="flex items-start gap-2.5 border-b px-4 py-3.5">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `hsl(${node.data.color} / 0.12)`, color: `hsl(${node.data.color})` }}
        >
        {createElement(node.data.icon, { "aria-hidden": true, className: "size-4" })}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Resource</p>
          <p className="mt-0.5 break-all font-mono text-[13px] font-medium leading-snug text-foreground">{node.id}</p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Copy address" onClick={copy} className="text-muted-foreground">
          {copied ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close details" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-2 px-4 pt-3.5">
        <StatTile label="Depends on" value={node.data.dependencies.length} />
        <StatTile label="Used by" value={node.data.dependents.length} />
      </div>
      <div className="px-4 pt-3.5">
        <SectionLabel>Attributes</SectionLabel>
        <dl className="mt-2 divide-y divide-border rounded-lg border">
          <AttributeRow label="Provider" value={node.data.provider} />
          <AttributeRow label="Type" value={node.data.providerType} />
          <AttributeRow label="Module" value={node.data.module} />
          {node.data.updatedAt !== "" && <AttributeRow label="Updated" value={formatDate(node.data.updatedAt)} />}
        </dl>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3.5">
        <div>
          <SectionLabel>Depends on</SectionLabel>
          <div className="mt-2">
            <RelationshipList items={node.data.dependencies} emptyLabel="Nothing in this state." onPick={onFocusNode} />
          </div>
        </div>
        <div>
          <SectionLabel>Used by</SectionLabel>
          <div className="mt-2">
            <RelationshipList items={node.data.dependents} emptyLabel="Nothing in this state." onPick={onFocusNode} />
          </div>
        </div>
      </div>
      <footer className="border-t px-4 py-2.5 text-[11px] text-muted-foreground">
        Click any resource in the graph to inspect it.
      </footer>
    </aside>
  );
}

function EdgeDetailsPanel({
  edge,
  onClose,
  onFocusNode,
}: Readonly<{
  edge: Readonly<{ from: string; to: string }>;
  onClose: () => void;
  onFocusNode: (address: string) => void;
}>): React.JSX.Element {
  return (
    <aside
      aria-label="Dependency details"
      className="absolute inset-y-0 right-0 z-20 flex w-80 flex-col border-l border-border bg-card shadow-[-8px_0_28px_-6px_rgba(0,0,0,0.3)] animate-in fade-in slide-in-from-right-4 duration-200"
    >
      <header className="flex items-start gap-2.5 border-b px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Dependency</p>
          <p className="mt-0.5 truncate font-mono text-[13px] font-medium text-foreground">
            {shortAddress(edge.from)} <ArrowRight className="inline size-3 text-muted-foreground" aria-hidden="true" /> {shortAddress(edge.to)}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close details" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="rounded-lg border p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Source</p>
          <p className="mt-1 break-all font-mono text-xs text-foreground">{edge.from}</p>
        </div>
        <ArrowRight aria-hidden="true" className="mx-auto my-2.5 size-4 text-muted-foreground" />
        <div className="rounded-lg border p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Target</p>
          <p className="mt-1 break-all font-mono text-xs text-foreground">{edge.to}</p>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          The target resource cannot be applied until the source resource has been applied first.
        </p>
        <div className="mt-4 flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" onClick={(): void => { onFocusNode(edge.from); }}>
            View source
          </Button>
          <Button variant="outline" size="sm" className="flex-1" onClick={(): void => { onFocusNode(edge.to); }}>
            View target
          </Button>
        </div>
      </div>
    </aside>
  );
}

function DetailsPanel({
  selection,
  nodes,
  onClose,
  onFocusNode,
}: Readonly<{
  selection: Exclude<Selection, null>;
  nodes: readonly ResourceFlowNode[];
  onClose: () => void;
  onFocusNode: (address: string) => void;
}>): React.JSX.Element | null {
  if (selection.kind === "edge") {
    return <EdgeDetailsPanel edge={selection} onClose={onClose} onFocusNode={onFocusNode} />;
  }
  const node = nodes.find((candidate): boolean => candidate.id === selection.address);
  if (node === undefined) return null;
  return <NodeDetailsPanel node={node} onClose={onClose} onFocusNode={onFocusNode} />;
}

export function DependencyGraph({
  resources,
  details,
}: Readonly<{
  resources: readonly DependencyGraphResource[];
  details?: Readonly<Record<string, ResourceDetails>>;
}>): React.JSX.Element {
  const graph = useMemo((): GraphModel | null => buildGraphModel(resources), [resources]);
  const dark = useDarkMode();
  const [nodes, setNodes] = useState<ResourceFlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const flowRef = useRef<ReactFlowInstance<ResourceFlowNode, FlowEdge> | null>(null);

  useEffect((): void => {
    if (graph === null) {
      setNodes([]);
      setEdges([]);
      setSelection(null);
      return;
    }
    setNodes(toFlowNodes(graph, details));
    setSelection(null);
  }, [graph, details]);

  useEffect((): void => {
    if (graph === null) return;
    setEdges(toFlowEdges(graph, dark));
  }, [graph, dark]);

  const onNodesChange = useCallback((changes: NodeChange<ResourceFlowNode>[]): void => {
    setNodes((current): ResourceFlowNode[] => applyNodeChanges(changes, current));
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]): void => {
    setEdges((current): FlowEdge[] => applyEdgeChanges(changes, current));
  }, []);

  const nodeTypes = useMemo<NodeTypes>((): NodeTypes => ({ resource: ResourceNodeComponent }), []);

  const onInit = useCallback((instance: ReactFlowInstance<ResourceFlowNode, FlowEdge>): void => {
    flowRef.current = instance;
  }, []);

  const focusNode = useCallback((address: string): void => {
    setSelection({ kind: "node", address });
    setNodes((current): ResourceFlowNode[] => current.map((node): ResourceFlowNode =>
      ({ ...node, selected: node.id === address })));
    const instance = flowRef.current;
    const target = instance?.getNodes().find((node): boolean => node.id === address);
    if (instance !== null && target !== undefined) {
      void instance.setCenter(target.position.x + NODE_WIDTH / 2, target.position.y + NODE_HEIGHT / 2, {
        zoom: 1.15,
        duration: 500,
      });
    }
  }, []);

  useEffect((): (() => void) => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setSelection(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return (): void => { window.removeEventListener("keydown", onKeyDown); };
  }, []);

  if (graph === null) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-2.5 px-6 py-10 text-center">
        <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Workflow className="size-5" />
        </span>
        <p className="text-sm text-muted-foreground">No dependency relationships are recorded in the current state.</p>
      </div>
    );
  }

  const backgroundColor = dark ? "rgba(148, 163, 184, 0.16)" : "rgba(100, 116, 139, 0.18)";

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-4 py-2.5">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{graph.nodes.length} resources</span>
          <span aria-hidden="true" className="mx-1.5">·</span>
          <span className="font-medium text-foreground">{graph.edges.length} dependencies</span>
        </p>
        <p className="hidden text-xs text-muted-foreground sm:block">Scroll to zoom · Drag to pan · Click a resource for details</p>
      </div>
      <div
        role="region"
        aria-label="Terraform resource dependency graph"
        className="dependency-graph relative h-[34rem] w-full overflow-hidden bg-background"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          colorMode={dark ? "dark" : "light"}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.25, duration: 500 }}
          minZoom={0.15}
          maxZoom={2.5}
          zoomOnDoubleClick={false}
          nodesDraggable={false}
          nodesConnectable={false}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
          aria-label="Terraform resource dependency graph"
          onInit={onInit}
          onNodeClick={(_event, node): void => { setSelection({ kind: "node", address: node.id }); }}
          onEdgeClick={(_event, edge): void => {
            if (edge.data === undefined) return;
            setSelection({ kind: "edge", from: edge.data.from, to: edge.data.to });
          }}
          onPaneClick={(): void => { setSelection(null); }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} color={backgroundColor} />
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
// SAFETY: node.data carries ResourceNodeData per the graph construction above.
            nodeColor={(node): string => `hsl(${(node.data as ResourceNodeData).color} / 0.9)`}
            nodeStrokeWidth={2}
            maskColor={dark ? "rgba(0, 0, 0, 0.55)" : "rgba(255, 255, 255, 0.6)"}
          />
        </ReactFlow>
        {selection !== null && (
          <DetailsPanel selection={selection} nodes={nodes} onClose={(): void => { setSelection(null); }} onFocusNode={focusNode} />
        )}
      </div>
    </>
  );
}
