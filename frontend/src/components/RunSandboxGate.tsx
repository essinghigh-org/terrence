import { useEffect, useState, type JSX, type ReactNode } from "react";

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
      data?: { "run-sandbox"?: RunSandboxStatus };
    };
    return payload.data?.["run-sandbox"] ?? null;
  } catch {
    return null;
  }
}

/**
 * Full-page gate: if the run sandbox is required (TERRENCE_RUN_SANDBOX not
 * "false") but Landlock is unavailable on the host kernel, the UI is locked
 * down so the operator must explicitly acknowledge the disabled control.
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

  if (status === undefined) {
    // Still probing — render nothing to avoid a flash.
    return <div className="min-h-screen bg-neutral-950" />;
  }

  if (status !== null && status.enabled && !status.available) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-950 p-6">
        <div className="max-w-2xl rounded-lg border border-amber-500/40 bg-neutral-900 p-8 text-neutral-100 shadow-xl">
          <div className="mb-3 flex items-center gap-3">
            <span className="text-3xl" role="img" aria-label="warning">⚠️</span>
            <h1 className="text-2xl font-semibold">Run sandbox is unavailable</h1>
          </div>
          <p className="mb-4 leading-relaxed text-neutral-300">
            Terrence requires its Landlock-based run sandbox to isolate
            Terraform/OpenTofu execution from the control plane, but Landlock
            is not available on this host.
          </p>
          <p className="mb-4 leading-relaxed text-neutral-300">
            {status.reason ?? "Unknown reason"} (probed ABI: {status.abi}).
            Terraform provider and provisioner code would otherwise be able to
            read the application database, encryption key, state archives and
            other workspaces&apos; configuration.
          </p>
          <div className="mb-6 rounded-md border border-neutral-700 bg-neutral-800 p-4">
            <p className="mb-2 font-medium">To continue, either:</p>
            <ul className="list-disc space-y-1 pl-5 text-neutral-300">
              <li>
                Enable Landlock on the host kernel (see{" "}
                <a
                  className="text-sky-400 underline hover:text-sky-300"
                  href={status.docs}
                  target="_blank"
                  rel="noreferrer"
                >
                  the kernel documentation
                </a>
                ). Requires Linux &ge; 5.13 with <code className="rounded bg-neutral-900 px-1">CONFIG_SECURITY_LANDLOCK</code>{" "}
                and the <code className="rounded bg-neutral-900 px-1">landlock</code> LSM enabled, or
                a container runtime configured to allow it.
              </li>
              <li>
                Explicitly disable the control by setting{" "}
                <code className="rounded bg-neutral-900 px-1">TERRENCE_RUN_SANDBOX=false</code>{" "}
                on the server and restarting. This acknowledges that runs are
                <strong> not isolated</strong> and untrusted IaC can access the host filesystem.
              </li>
            </ul>
          </div>
          <p className="text-sm text-neutral-500">
            Runs are blocked until this is resolved. This page will re-check automatically on reload.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}