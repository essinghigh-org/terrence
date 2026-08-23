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
