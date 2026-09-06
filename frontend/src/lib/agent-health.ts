import { isString } from "./type-guards";

/** The JSON:API fields exposed by the agent-pool read surface. */
export type AgentHealthRecord = Readonly<{
  id: string;
  attributes: Readonly<{
    name?: string;
    status?: string;
    version?: string | null;
    architecture?: string | null;
    "iac-binaries"?: readonly string[];
    "last-ping-at"?: string | null;
  }>;
}>;

export type AgentHealthState = "idle" | "busy" | "draining" | "stale" | "offline" | "unknown";

export type AgentHealthSummary = Readonly<{
  total: number;
  usable: number;
  idle: number;
  busy: number;
  draining: number;
  stale: number;
  failed: number;
}>;


/**
 * Turn the server's recorded status into a display state without claiming a
 * live connection. A status of `unknown` or a missing heartbeat is stale even
 * when the worker was previously idle; the timestamp remains the evidence the
 * operator can inspect.
 */
export function agentHealthState(agent: AgentHealthRecord): AgentHealthState {
  const status = agent.attributes.status?.toLowerCase() ?? "unknown";
  if (status === "draining" || status === "drain") return "draining";
  if (status === "exited" || status === "offline" || status === "errored" || status === "error") return "offline";
  if (agent.attributes["last-ping-at"] === null || agent.attributes["last-ping-at"] === undefined) return "stale";
  if (status === "idle") return "idle";
  if (status === "busy") return "busy";
  if (status === "unknown") return "stale";
  return "unknown";
}

export function summarizeAgentHealth(agents: readonly AgentHealthRecord[]): AgentHealthSummary {
  let idle = 0;
  let busy = 0;
  let draining = 0;
  let stale = 0;
  let failed = 0;
  for (const agent of agents) {
    switch (agentHealthState(agent)) {
      case "idle": idle += 1; break;
      case "busy": busy += 1; break;
      case "draining": draining += 1; break;
      case "stale": stale += 1; break;
      case "offline": failed += 1; break;
      case "unknown": failed += 1; break;
    }
  }
  return {
    total: agents.length,
    usable: idle + busy,
    idle,
    busy,
    draining,
    stale,
    failed,
  };
}

export function agentStatusLabel(state: AgentHealthState): string {
  switch (state) {
    case "idle": return "Idle";
    case "busy": return "Busy";
    case "draining": return "Draining";
    case "stale": return "Heartbeat stale";
    case "offline": return "Offline";
    case "unknown": return "Unknown";
  }
}

export function formatLastObserved(value: string | null | undefined, now = Date.now()): string {
  if (!isString(value) || value === "") return "Never observed";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Invalid timestamp";
  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (elapsedSeconds < 60) return "Observed less than a minute ago";
  if (elapsedSeconds < 3_600) return `Observed ${Math.floor(elapsedSeconds / 60)}m ago`;
  if (elapsedSeconds < 86_400) return `Observed ${Math.floor(elapsedSeconds / 3_600)}h ago`;
  return `Observed ${Math.floor(elapsedSeconds / 86_400)}d ago`;
}

export function agentCapabilities(agent: AgentHealthRecord): readonly string[] {
  const binaries = agent.attributes["iac-binaries"];
  if (Array.isArray(binaries)) {
    const capabilities: string[] = [];
    for (const binary of binaries) if (isString(binary)) capabilities.push(binary);
    if (capabilities.length > 0) return capabilities;
  }
  return ["terraform"];
}
