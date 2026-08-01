export type DependencyGraphResource = Readonly<{
  address: string;
  dependencies: readonly string[];
}>;

type GraphNode = DependencyGraphResource;
type GraphEdge = Readonly<{ from: string; to: string }>;
type GraphLayout = Readonly<{
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  positions: ReadonlyMap<string, Readonly<{ x: number; y: number }>>;
  width: number;
  height: number;
}>;

function buildGraph(resources: readonly DependencyGraphResource[]): GraphLayout | null {
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
  const nodes = [...resourcesByAddress.values()].map((resource): GraphNode => ({
    ...resource,
    dependencies: resource.dependencies.filter((dependency): boolean => resourcesByAddress.has(dependency)),
  }));
  const nodeAddresses = new Set(nodes.map((node): string => node.address));
  const edges = nodes.flatMap((node): readonly GraphEdge[] => node.dependencies
    .filter((dependency): boolean => nodeAddresses.has(dependency))
    .map((dependency): GraphEdge => ({ from: dependency, to: node.address })));
  if (nodes.length < 2 || edges.length === 0) return null;

  const levels = new Map<string, number>();
  const nodesByAddress = new Map(nodes.map((node): [string, GraphNode] => [node.address, node]));
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

  const byLevel = new Map<number, GraphNode[]>();
  nodes.forEach((node): void => {
    const level = levels.get(node.address) ?? 0;
    const column = byLevel.get(level) ?? [];
    column.push(node);
    byLevel.set(level, column);
  });
  const nodeWidth = 190;
  const nodeHeight = 48;
  const horizontalGap = 52;
  const verticalGap = 18;
  const positions = new Map<string, Readonly<{ x: number; y: number }>>();
  [...byLevel.entries()].forEach(([level, column]): void => {
    column.sort((left, right): number => left.address.localeCompare(right.address));
    column.forEach((node, index): void => {
      positions.set(node.address, {
        x: 24 + level * (nodeWidth + horizontalGap),
        y: 24 + index * (nodeHeight + verticalGap),
      });
    });
  });

  return {
    nodes,
    edges,
    positions,
    width: Math.max(720, [...byLevel.keys()].length * (nodeWidth + horizontalGap) + 24),
    height: Math.max(150, Math.max(...[...byLevel.values()].map((column): number => column.length)) * (nodeHeight + verticalGap) + 30),
  };
}

function shortAddress(address: string): string {
  const segments = address.split(".");
  return segments.length > 2 ? `…${segments.slice(-2).join(".")}` : address;
}

export function DependencyGraph({
  resources,
}: Readonly<{
  resources: readonly DependencyGraphResource[];
}>): React.JSX.Element {
  const graph = buildGraph(resources);
  if (graph === null) return <></>;

  return (
    <details className="border-t border-border">
      <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        Dependency graph <span className="font-normal text-muted-foreground">({graph.nodes.length} resources · {graph.edges.length} dependencies)</span>
      </summary>
      <div className="border-t border-border bg-muted/20 px-4 py-4">
        <p className="mb-3 text-xs text-muted-foreground">Arrows point from a prerequisite to the resource that depends on it.</p>
        <div className="overflow-x-auto rounded-md border border-border bg-background p-2">
          <svg
            role="img"
            aria-label="Terraform resource dependency graph"
            width={graph.width}
            height={graph.height}
            viewBox={`0 0 ${graph.width} ${graph.height}`}
            className="max-w-none"
          >
            <defs>
              <marker id="dependency-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="hsl(var(--muted-foreground))" />
              </marker>
            </defs>
            <g stroke="hsl(var(--muted-foreground))" strokeWidth="1.5" markerEnd="url(#dependency-arrow)">
              {graph.edges.map((edge): React.JSX.Element | null => {
                const from = graph.positions.get(edge.from);
                const to = graph.positions.get(edge.to);
                if (from === undefined || to === undefined) return null;
                return (
                  <line
                    key={`${edge.from}->${edge.to}`}
                    x1={from.x + 190}
                    y1={from.y + 24}
                    x2={to.x}
                    y2={to.y + 24}
                  />
                );
              })}
            </g>
            {graph.nodes.map((node): React.JSX.Element => {
              const position = graph.positions.get(node.address);
              if (position === undefined) return <g key={node.address} />;
              return (
                <g key={node.address}>
                  <title>{node.address}</title>
                  <rect x={position.x} y={position.y} width="190" height="48" rx="8" fill="hsl(var(--card))" stroke="hsl(var(--border))" />
                  <text x={position.x + 12} y={position.y + 20} fill="hsl(var(--foreground))" fontSize="11" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
                    {shortAddress(node.address)}
                  </text>
                  <text x={position.x + 12} y={position.y + 37} fill="hsl(var(--muted-foreground))" fontSize="10" fontFamily="ui-sans-serif, system-ui, sans-serif">
                    Current state
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </details>
  );
}
