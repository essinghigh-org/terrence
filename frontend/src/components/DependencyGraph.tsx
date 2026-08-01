type GraphResource = Readonly<{
  address: string;
  dependencies: readonly string[];
}>;

type GraphChange = Readonly<{
  address: string;
  operation: string;
}>;

type GraphNode = GraphResource & Readonly<{ operation: string }>;
type GraphEdge = Readonly<{ from: string; to: string }>;
type GraphLayout = Readonly<{
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  positions: ReadonlyMap<string, Readonly<{ x: number; y: number }>>;
  width: number;
  height: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValues(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function collectReferences(value: unknown, references: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item): void => { collectReferences(item, references); });
    return;
  }
  if (!isRecord(value)) return;
  stringValues(value["references"]).forEach((reference): void => { references.add(reference); });
  Object.entries(value).forEach(([key, child]): void => {
    if (key !== "references") collectReferences(child, references);
  });
}

function resourcesFromModule(value: unknown): readonly GraphResource[] {
  if (!isRecord(value)) return [];
  const resources = Array.isArray(value["resources"])
    ? value["resources"].flatMap((resource): readonly GraphResource[] => {
        if (!isRecord(resource) || typeof resource["address"] !== "string") return [];
        const dependencies = new Set<string>(stringValues(resource["depends_on"]));
        collectReferences(resource["expressions"], dependencies);
        return [{ address: resource["address"], dependencies: [...dependencies] }];
      })
    : [];
  const childModules = Array.isArray(value["child_modules"])
    ? value["child_modules"].flatMap(resourcesFromModule)
    : [];
  const moduleCalls = isRecord(value["module_calls"])
    ? Object.values(value["module_calls"]).flatMap((call): readonly GraphResource[] =>
        isRecord(call) ? resourcesFromModule(call["module"]) : [],
      )
    : [];
  return [...resources, ...childModules, ...moduleCalls];
}

function resolveResourceAddress(reference: string, addresses: readonly string[]): string | undefined {
  return addresses
    .filter((address): boolean => reference === address
      || reference.startsWith(`${address}.`)
      || reference.startsWith(`${address}[`))
    .sort((left, right): number => right.length - left.length)[0];
}

function buildGraph(configuration: unknown, changes: readonly GraphChange[]): GraphLayout | null {
  if (!isRecord(configuration)) return null;
  const resourcesByAddress = new Map<string, GraphResource>();
  resourcesFromModule(configuration["root_module"]).forEach((resource): void => {
    const existing = resourcesByAddress.get(resource.address);
    resourcesByAddress.set(resource.address, existing === undefined
      ? resource
      : {
          address: resource.address,
          dependencies: [...new Set([...existing.dependencies, ...resource.dependencies])],
        });
  });
  const addresses = [...resourcesByAddress.keys()];
  if (addresses.length < 2) return null;

  const resolvedResources = new Map<string, GraphResource>(
    [...resourcesByAddress].map(([address, resource]): [string, GraphResource] => [address, {
      address,
      dependencies: resource.dependencies
        .map((reference): string | undefined => resolveResourceAddress(reference, addresses))
        .filter((dependency): dependency is string => dependency !== undefined && dependency !== address),
    }]),
  );
  const operationByAddress = new Map(changes.map((change): [string, string] => [change.address, change.operation]));
  const selected = new Set(changes.map((change): string => change.address));
  const queue = [...selected];
  while (queue.length > 0) {
    const address = queue.pop();
    if (address === undefined) continue;
    resolvedResources.get(address)?.dependencies.forEach((dependency): void => {
      if (!selected.has(dependency)) {
        selected.add(dependency);
        queue.push(dependency);
      }
    });
  }

  const nodes = [...resolvedResources.values()]
    .filter((resource): boolean => selected.has(resource.address))
    .map((resource): GraphNode => ({
      ...resource,
      operation: operationByAddress.get(resource.address) ?? "unchanged",
      dependencies: resource.dependencies.filter((dependency): boolean => selected.has(dependency)),
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

function nodeColors(operation: string): Readonly<{ fill: string; stroke: string; text: string }> {
  if (operation === "create") return { fill: "#ecfdf5", stroke: "#86efac", text: "#166534" };
  if (operation === "update") return { fill: "#eff6ff", stroke: "#93c5fd", text: "#1d4ed8" };
  if (operation === "delete") return { fill: "#fef2f2", stroke: "#fca5a5", text: "#b91c1c" };
  if (operation === "replace") return { fill: "#fffbeb", stroke: "#fcd34d", text: "#b45309" };
  if (operation === "import") return { fill: "#f9fafb", stroke: "#9ca3af", text: "#374151" };
  return { fill: "#ffffff", stroke: "#d1d5db", text: "#4b5563" };
}

function shortAddress(address: string): string {
  const segments = address.split(".");
  return segments.length > 2 ? `…${segments.slice(-2).join(".")}` : address;
}

export function DependencyGraph({
  configuration,
  changes,
}: Readonly<{
  configuration?: unknown;
  changes: readonly GraphChange[];
}>): React.JSX.Element {
  const graph = buildGraph(configuration, changes);
  if (graph === null) return <></>;

  return (
    <details className="border-t border-gray-200">
      <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600">
        Dependency graph <span className="font-normal text-gray-500">({graph.nodes.length} resources · {graph.edges.length} dependencies)</span>
      </summary>
      <div className="border-t border-gray-100 bg-slate-50/60 px-4 py-4">
        <p className="mb-3 text-xs text-gray-600">Arrows point from a prerequisite to the resource that depends on it.</p>
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white p-2">
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
                <path d="M0,0 L8,4 L0,8 z" fill="#94a3b8" />
              </marker>
            </defs>
            <g stroke="#94a3b8" strokeWidth="1.5" markerEnd="url(#dependency-arrow)">
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
              const colors = nodeColors(node.operation);
              if (position === undefined) return <g key={node.address} />;
              return (
                <g key={node.address}>
                  <title>{node.address}</title>
                  <rect x={position.x} y={position.y} width="190" height="48" rx="8" fill={colors.fill} stroke={colors.stroke} />
                  <text x={position.x + 12} y={position.y + 20} fill="#111827" fontSize="11" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
                    {shortAddress(node.address)}
                  </text>
                  <text x={position.x + 12} y={position.y + 37} fill={colors.text} fontSize="10" fontFamily="ui-sans-serif, system-ui, sans-serif">
                    {node.operation}
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
