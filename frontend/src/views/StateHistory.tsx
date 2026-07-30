import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchAllApiPages, fetchApi } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type StateItem = {
  id: string;
  attributes: Record<string, unknown>;
  relationships?: {
    run?: { data: { id: string; type: string } | null };
  };
};

function stateStatus(value: unknown): string {
  if (typeof value !== "string" || value === "") return "Finalized";
  const labels: Record<string, string> = {
    pending: "Pending",
    finalized: "Finalized",
  };
  return labels[value] ?? value.replace(/_/g, " ").replace(/\b\w/g, (c: string): string => c.toUpperCase());
}

function runStatusLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c: string): string => c.toUpperCase());
}

type StateHistoryProps = {
  workspaceId: string;
  orgName?: string;
  workspaceName?: string;
}

type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "ready"; states: StateItem[] }>;

function formatDate(value: unknown): string {
  if (typeof value !== "string" || value === "") return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString();
}

export function StateHistory({ workspaceId, orgName, workspaceName }: StateHistoryProps): React.JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [loadingStateId, setLoadingStateId] = useState<string | null>(null);

  useEffect((): (() => void) => {
    const controller = new AbortController();
    setLoadState({ kind: "loading" });
    void fetchAllApiPages<StateItem>(`/workspaces/${workspaceId}/state-versions`, controller.signal)
      .then((states: StateItem[]): void => {
        if (!controller.signal.aborted) setLoadState({ kind: "ready", states });
      })
      .catch((error: unknown): void => {
        if (!controller.signal.aborted) {
          setLoadState({
            kind: "error",
            message: error instanceof Error ? error.message : "Failed to load state version history",
          });
        }
      });
    return (): void => {
      controller.abort();
    };
  }, [retry, workspaceId]);

  const handleViewJson = async (s: StateItem): Promise<void> => {
    const stateStr = s.attributes["state"] as string | undefined;
    if (stateStr != null) {
      try {
        const parsed: unknown = typeof stateStr === "string" ? JSON.parse(stateStr) : stateStr;
        setSelectedState(JSON.stringify(parsed, null, 2));
      } catch {
        setSelectedState(stateStr);
      }
      return;
    }

    setLoadingStateId(s.id);
    try {
      const res = await fetchApi(`/state-versions/${s.id}`) as { data?: { attributes?: Record<string, unknown> } };
      const rawPayload = (res.data?.attributes?.["state"] as string | undefined) ?? "{}";
      try {
        const parsed: unknown = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
        setSelectedState(JSON.stringify(parsed, null, 2));
      } catch {
        setSelectedState(rawPayload);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load state version JSON";
      toast.add({ title: "Could not load state", description: msg, type: "error" });
    } finally {
      setLoadingStateId(null);
    }
  };

  const handleDownload = async (s: StateItem): Promise<void> => {
    try {
      const rawText: unknown = await fetchApi(`/state-versions/${s.id}/download`);
      const payloadString = typeof rawText === "string" ? rawText : JSON.stringify(rawText, null, 2);
      const blob = new Blob([payloadString], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const serial = (s.attributes["serial"] as number | undefined) ?? 1;
      a.download = `terraform-state-v${serial}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.add({ title: "State downloaded", type: "success" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to download state version";
      toast.add({ title: "Could not download state", description: msg, type: "error" });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-semibold">State version history</h2>
        <p className="mt-1 text-sm text-muted-foreground">Browse historical state, inspect the run that produced it, and download a safe copy for recovery.</p>
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Run</TableHead>
              <TableHead>Commit</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loadState.kind === "loading" && (
              <TableRow>
                <TableCell colSpan={5} className="py-8">
                  <div role="status" className="flex items-center justify-center gap-2 text-muted-foreground">
                    <Spinner />
                    Loading state versions…
                  </div>
                </TableCell>
              </TableRow>
            )}
            {loadState.kind === "error" && (
              <TableRow>
                <TableCell colSpan={5} className="py-8">
                  <div role="alert" className="mx-auto max-w-md text-center">
                    <p className="font-medium text-destructive">Could not load state version history</p>
                    <p className="mt-1 text-sm text-muted-foreground">{loadState.message}</p>
                    <Button
                      className="mt-3"
                      variant="outline"
                      onClick={(): void => { setRetry((value: number): number => value + 1); }}
                    >
                      Try again
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
            {loadState.kind === "ready" && loadState.states.map((s: StateItem): React.JSX.Element => (
              <TableRow key={s.id}>
                <TableCell>
                  <p className="font-bold">#{s.attributes["serial"] as number}</p>
                  <p className="font-mono text-xs text-muted-foreground">{s.id}</p>
                </TableCell>
                <TableCell className="text-sm">{formatDate(s.attributes["created-at"])}</TableCell>
                <TableCell className="font-mono text-xs">
                  {s.relationships?.run?.data?.id != null ? (
                    <div className="flex flex-col gap-0.5">
                      <Link
                        to={`/app/${encodeURIComponent(orgName ?? "")}/workspaces/${encodeURIComponent(workspaceName ?? "")}/runs/${encodeURIComponent(s.relationships.run.data.id)}`}
                        className="text-primary hover:underline"
                      >
                        {typeof s.attributes["run-message"] === "string" && s.attributes["run-message"] !== ""
                          ? s.attributes["run-message"]
                          : "Manual run"}
                      </Link>
                      <span className="text-[11px] text-muted-foreground">
                        {typeof s.attributes["run-status"] === "string"
                          ? runStatusLabel(s.attributes["run-status"])
                          : "Run Status Unknown"}
                      </span>
                      <span className="text-[11px] text-muted-foreground">{stateStatus(s.attributes["status"])}</span>
                    </div>
                  ) : "—"}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {typeof s.attributes["vcs-commit-sha"] === "string" ? (
                    typeof s.attributes["vcs-commit-url"] === "string" ? (
                      <a
                        href={s.attributes["vcs-commit-url"]}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        {s.attributes["vcs-commit-sha"].slice(0, 8)}
                      </a>
                    ) : s.attributes["vcs-commit-sha"].slice(0, 8)
                  ) : "—"}
                </TableCell>
                <TableCell className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadingStateId === s.id}
                    onClick={(): void => { void handleViewJson(s); }}
                  >
                    {loadingStateId === s.id ? "Loading..." : "View JSON"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={(): void => { void handleDownload(s); }}>
                    Download state
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {loadState.kind === "ready" && loadState.states.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-gray-500 py-8">
                  No state versions recorded yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={selectedState != null} onOpenChange={(): void => { setSelectedState(null); }}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>State Payload JSON</DialogTitle>
          </DialogHeader>
          <pre className="bg-slate-900 text-slate-100 p-4 rounded-md text-xs font-mono overflow-x-auto whitespace-pre-wrap">
            {selectedState}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
