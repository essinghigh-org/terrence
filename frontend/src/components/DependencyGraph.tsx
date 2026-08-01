import React, { useMemo, useState } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  type Node,
  type Edge,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Resource } from "@/components/WorkspaceResources";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

export type DependencyGraphResource = Readonly<{
  address: string;
  dependencies: readonly string[];
}>;

type GraphNode = DependencyGraphResource;
type GraphLayout = Readonly<{
  nodes: readonly Node[];
  edges: readonly Edge[];
}>;

function shortAddress(address: string): string {
  const segments = address.split(".");
  return segments.length > 2 ? `…${segments.slice(-2).join(".")}` : address;
}

function buildGraph(resources: readonly DependencyGraphResource[]): GraphLayout | null {
  const resourcesByAddress = new Map<string, DependencyGraphResource>();
  resources.forEach((resource): void => {
    const existing = resourcesByAddress.get(resource.address);
    resourcesByAddress.set(
      resource.address,
      existing === undefined
        ? resource
        : {
            address: resource.address,
            dependencies: [...new Set([...existing.dependencies, ...resource.dependencies])],
          }
    );
  });
  const nodesList = [...resourcesByAddress.values()].map(
    (resource): GraphNode => ({
      ...resource,
      dependencies: resource.dependencies.filter((dependency): boolean => resourcesByAddress.has(dependency)),
    })
  );
  const nodeAddresses = new Set(nodesList.map((node): string => node.address));
  const edgesList = nodesList.flatMap((node): Readonly<{ from: string; to: string }>[] =>
    node.dependencies
      .filter((dependency): boolean => nodeAddresses.has(dependency))
      .map((dependency): Readonly<{ from: string; to: string }> => ({ from: dependency, to: node.address }))
  );
  if (nodesList.length < 2 || edgesList.length === 0) return null;

  const levels = new Map<string, number>();
  const nodesByAddress = new Map(nodesList.map((node): [string, GraphNode] => [node.address, node]));
  const visiting = new Set<string>();
  const levelFor = (address: string): number => {
    const cached = levels.get(address);
    if (cached !== undefined) return cached;
    if (visiting.has(address)) return 0;
    visiting.add(address);
    const node = nodesByAddress.get(address);
    const level =
      node === undefined
        ? 0
        : Math.max(0, ...node.dependencies.map((dependency): number => levelFor(dependency) + 1));
    visiting.delete(address);
    levels.set(address, level);
    return level;
  };
  nodesList.forEach((node): void => {
    levelFor(node.address);
  });

  const byLevel = new Map<number, GraphNode[]>();
  nodesList.forEach((node): void => {
    const level = levels.get(node.address) ?? 0;
    const column = byLevel.get(level) ?? [];
    column.push(node);
    byLevel.set(level, column);
  });

  const nodeWidth = 220;
  const nodeHeight = 60;
  const horizontalGap = 80;
  const verticalGap = 40;
  const nodes: Node[] = [];

  [...byLevel.entries()].forEach(([level, column]): void => {
    column.sort((left, right): number => left.address.localeCompare(right.address));
    column.forEach((node, index): void => {
      nodes.push({
        id: node.address,
        position: {
          x: 24 + level * (nodeWidth + horizontalGap),
          y: 24 + index * (nodeHeight + verticalGap),
        },
        data: { label: shortAddress(node.address), address: node.address },
        style: {
          width: nodeWidth,
          height: nodeHeight,
          background: "hsl(var(--card))",
          border: "1px solid hsl(var(--border))",
          borderRadius: "8px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "12px",
          color: "hsl(var(--foreground))",
          padding: "10px",
          boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05)",
          cursor: "pointer",
        },
      });
    });
  });

  const edges: Edge[] = edgesList.map((edge): Edge => ({
    id: `${edge.from}->${edge.to}`,
    source: edge.from,
    target: edge.to,
    animated: false,
    style: { stroke: "hsl(var(--muted-foreground))", strokeWidth: 1.5 },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 20,
      height: 20,
      color: "hsl(var(--muted-foreground))",
    },
  }));

  return { nodes, edges };
}

export function DependencyGraph({
  resources,
  allResources,
}: Readonly<{
  resources: readonly DependencyGraphResource[];
  allResources: readonly Resource[];
}>): React.JSX.Element {
  const graph = useMemo((): GraphLayout | null => buildGraph(resources), [resources]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const selectedResource = useMemo((): Resource | null => {
    if (selectedNodeId === null || selectedNodeId === "") return null;
    return allResources.find((r): boolean => r.attributes.address === selectedNodeId) ?? null;
  }, [selectedNodeId, allResources]);

  if (graph === null) {
    return (
      <div className="flex min-h-36 items-center justify-center px-6 text-center text-sm text-muted-foreground border-t border-border">
        No dependency relationships are recorded in the current state.
      </div>
    );
  }

  return (
    <div className="border-t border-border flex flex-col">
      <div className="px-5 py-3 border-b border-border bg-muted/20">
        <h3 className="text-sm font-medium text-foreground">
          Dependency graph{" "}
          <span className="font-normal text-muted-foreground">
            ({graph.nodes.length} resources · {graph.edges.length} dependencies)
          </span>
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Interactive view: Scroll to zoom, click and drag to pan, and select a node to view its details. Arrows point from a prerequisite to the resource that depends on it.
        </p>
      </div>
      <div style={{ width: "100%", height: "600px" }} className="bg-background">
        <ReactFlow
          nodes={graph.nodes as Node[]}
          edges={graph.edges as Edge[]}
          onNodeClick={(_: React.MouseEvent, node: Node): void => { setSelectedNodeId(node.id); }}
          fitView
          attributionPosition="bottom-right"
        >
          <Controls />
          <Background color="hsl(var(--muted-foreground))" gap={16} />
        </ReactFlow>
      </div>

      <Sheet open={selectedNodeId !== null} onOpenChange={(open: boolean): void => { if (!open) setSelectedNodeId(null); }}>
        <SheetContent className="overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="font-mono text-sm break-all">
              {selectedNodeId}
            </SheetTitle>
            <SheetDescription>Resource Details</SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-4">
            {selectedResource !== null ? (
              <>
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Provider</h4>
                  <p className="text-sm">{selectedResource.attributes.provider ?? "—"}</p>
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Type</h4>
                  <p className="text-sm">{selectedResource.attributes["provider-type"] ?? "—"}</p>
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Module</h4>
                  <p className="text-sm">{selectedResource.attributes.module ?? "root"}</p>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No additional details available in the current state for this resource.
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
