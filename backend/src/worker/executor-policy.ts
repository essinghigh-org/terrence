import { executionSetting } from "../lib/runtime-config";
/** Executor policy (todo 35) — pluggable backend declaration + enforcement layer. */
export type ExecutorBackend = "landlock" | "container" | "kubernetes" | "agent" | "microvm";
export const EXECUTOR_BACKENDS: ExecutorBackend[] = ["landlock","container","kubernetes","agent","microvm"] as const;

export function executorBackendFromEnv(): ExecutorBackend {
  return executionSetting("TERRENCE_EXECUTOR_BACKEND");
}

export function executorPolicyAllowsLocal(allowed: ExecutorBackend[]): boolean {
  return allowed.includes("landlock");
}

function projectExecutionDenial(backend: ExecutorBackend, allowedModes: string): string | undefined {
  const allowed = allowedModes.split(",").map((s) => s.trim()).filter(Boolean);
  const backendMode = backend === "agent" ? "agent" : backend === "landlock" ? "remote" : backend;
  const allowsAgentAlias = backend === "agent" && allowed.includes("remote:agent");
  if (!allowed.includes(backendMode) && !allowed.includes(backend) && !allowsAgentAlias && !allowed.includes("*")) {
    return `Project restricts execution to [${allowed.join(", ")}]; ${backend} is not allowed.`;
  }
  return undefined;
}

/** Full executor policy check against workspace/project/org constraints (todos 36-39). */
export function executorPolicyAllows(
  backend: ExecutorBackend,
  workspace: Readonly<{ trustedExecution?: boolean | null }> | null,
  project: Readonly<{ allowedExecutionModes?: string | null }> | null,
  organization: Readonly<{ requireHardIsolation?: boolean | null }> | null,
): { allowed: true } | { allowed: false; reason: string } {
  if (workspace?.trustedExecution === false && backend === "landlock") {
    return { allowed: false, reason: "Workspace is marked untrusted: local execution is refused. Use an isolated executor (agent/container)." };
  }
  const allowedModes = project?.allowedExecutionModes;
  if (allowedModes !== null && allowedModes !== undefined && allowedModes !== "") {
    const denial = projectExecutionDenial(backend, allowedModes);
    if (denial !== undefined) return { allowed: false, reason: denial };
  }
  if (organization?.requireHardIsolation === true && backend === "landlock") {
    return { allowed: false, reason: "Organization requires hard isolation: local execution is disabled." };
  }
  return { allowed: true };
}

/** Whether any allowed backend includes a hard-isolated executor. */
export function hasHardIsolation(allowed: ExecutorBackend[]): boolean {
  return allowed.some((b) => b !== "landlock");
}
