/** Executor policy (todo 35) — pluggable backend declaration layer. */
export type ExecutorBackend = "landlock" | "container" | "kubernetes" | "agent" | "microvm";
export const EXECUTOR_BACKENDS: ExecutorBackend[] = ["landlock","container","kubernetes","agent","microvm"];

export function executorBackendFromEnv(): ExecutorBackend {
  const raw = (process.env.TERRENCE_EXECUTOR_BACKEND ?? "").trim().toLowerCase();
  if ((EXECUTOR_BACKENDS as string[]).includes(raw)) return raw as ExecutorBackend;
  return "landlock";
}

export function executorPolicyAllowsLocal(allowed: ExecutorBackend[]): boolean {
  return allowed.includes("landlock");
}

export interface ExecutorCapability {
  backend: ExecutorBackend;
  isolation: "landlock" | "netns" | "container" | "k8s-job" | "microvm";
  doc: string;
}

export const EXECUTOR_CAPABILITIES: ExecutorCapability[] = [
  { backend: "landlock", isolation: "landlock", doc: "31: netns isolation is a Landlock + netns toggle (TERRENCE_RUN_NET_POLICY)." },
  { backend: "container", isolation: "container", doc: "32: per-run container executor (podman/docker) stub." },
  { backend: "kubernetes", isolation: "k8s-job", doc: "33: Kubernetes Job executor stub." },
  { backend: "agent", isolation: "container", doc: "agent executor — workload identity path." },
  { backend: "microvm", isolation: "microvm", doc: "34: Firecracker/microVM executor stub." },
];

export function capabilityFor(backend: ExecutorBackend): ExecutorCapability {
  const c = EXECUTOR_CAPABILITIES.find((x) => x.backend === backend);
  if (c === undefined) throw new Error(`Unknown executor backend: ${backend}`);
  return c;
}
