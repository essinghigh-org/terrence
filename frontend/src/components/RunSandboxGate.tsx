import { useEffect, useState, type JSX, type ReactNode } from "react";
import { safeHttpUrl } from "@/lib/safe-url";

type RunSandboxStatus = Readonly<{
  enabled: boolean;
  available: boolean;
  abi: number;
  reason: string | null;
  docs: string;
}>;

async function fetchRunSandboxStatus(): Promise<RunSandboxStatus | null> {
  try {
    const response = await fetch("/api/v2/meta", { credentials: "same-origin" });
    if (!response.ok) return null;
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
    const payload = (await response.json()) as {
      data?: { attributes?: { "run-sandbox"?: RunSandboxStatus } };
    };
    return payload.data?.attributes?.["run-sandbox"] ?? null;
  } catch {
    return null;
  }
}

/**
 * Sandbox warning banner (issue #566): when the run sandbox is required but
 * Landlock is unavailable on the host, show a persistent, non-dismissing
 * banner instead of locking the whole UI. Navigation, login, state, and
 * docs keep working; only remote execution is affected. Previously this was
 * a full-page gate that blocked login and configuration on hosts without
 * Landlock (Docker Desktop, unprivileged LXC, NAS appliances, old kernels).
 */
export function RunSandboxGate({ children }: Readonly<{ readonly children: ReactNode }>): JSX.Element {
  const [status, setStatus] = useState<RunSandboxStatus | null | undefined>(undefined);

  useEffect((): (() => void) => {
    let cancelled = false;
    void fetchRunSandboxStatus().then((result): void => {
      if (!cancelled) setStatus(result);
    });
    return (): void => {
      cancelled = true;
    };
  }, []);

  const blocked = status !== null && status !== undefined && status.enabled && !status.available;
  const docsUrl = blocked ? safeHttpUrl(status.docs) : null;

  return (
    <>
      {blocked && (
        <div role="alert" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warning/40 bg-warning/10 px-4 py-2 text-center text-sm text-warning">
          <span aria-hidden="true">⚠️</span>
          <span>
            Run sandbox unavailable{status.reason !== null && status.reason !== "" ? `: ${status.reason}` : ""} (probed ABI: {status.abi}).
            Remote runs will fail. Enable Landlock on the host kernel or set <code className="rounded bg-muted px-1">TERRENCE_RUN_SANDBOX=false</code> on the server and restart.
          </span>
          {docsUrl !== null && (
            <a className="underline hover:text-warning/80" href={docsUrl} target="_blank" rel="noreferrer">
              Kernel docs
            </a>
          )}
        </div>
      )}
      {children}
    </>
  );
}
