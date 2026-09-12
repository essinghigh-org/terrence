import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { fetchApi } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { type DataItem, } from "./types";
// Live run-concurrency surface (issue #632), best-effort: the queue table
// renders without it when system-info is unreachable.
type QueueStats = { limit: number; executing: number; queued: number | null };
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function QueueExplanationCell({
  inspection,
  reason,
  state,
  position,
  positionQualified,
}: Readonly<{
  inspection: JsonRecord | null;
  reason: string | null;
  state: string | null;
  position: number | null;
  positionQualified: boolean;
}>): React.JSX.Element {
  if (inspection === null) return <>No queue explanation available.</>;
  return (
    <div className="space-y-1">
      <div className="font-medium text-foreground">{reason ?? "Queue state unavailable"}</div>
      <div>{state ?? "unknown"}{positionQualified ? ` · position ${String(position)}` : ""}</div>
      {typeof inspection["reason-code"] === "string" && <div className="font-mono text-[11px]">{inspection["reason-code"]}</div>}
    </div>
  );
}

function RunQueueRow({
  r,
  onCancelRun,
}: Readonly<{
  r: DataItem;
  onCancelRun: (runId: string, force?: boolean) => Promise<void>;
}>): React.JSX.Element {
  const inspection = record(r.attributes["queue-inspection"]);
  const reason = inspection !== null && typeof inspection["reason"] === "string" ? inspection["reason"] : null;
  const state = inspection !== null && typeof inspection["state"] === "string" ? inspection["state"] : null;
  const position = inspection === null ? null : numberValue(inspection["position"]);
  const positionQualified = inspection?.["position-qualified"] === true;
  return (
    <TableRow className="hover:bg-muted/50">
      <TableCell className="px-4 py-3 font-mono text-xs font-semibold text-foreground">{r.id}</TableCell>
      <TableCell className="px-4 py-3">
        <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
          {r.attributes.status}
        </span>
      </TableCell>
      <TableCell className="px-4 py-3 text-muted-foreground">{r.attributes.message ?? "—"}</TableCell>
      <TableCell className="px-4 py-3 text-xs text-muted-foreground">
        <QueueExplanationCell
          inspection={inspection}
          reason={reason}
          state={state}
          position={position}
          positionQualified={positionQualified}
        />
      </TableCell>
      <TableCell className="px-4 py-3">
        {r.attributes.actions !== undefined && (
          <div className="flex gap-2">
            {r.attributes.actions["is-cancelable"] === true && (
              <Button size="sm" variant="outline" onClick={(): void => { void onCancelRun(r.id, false); }}>
                Cancel
              </Button>
            )}
            {r.attributes.actions["is-force-cancelable"] === true && (
              <Button size="sm" variant="destructive" onClick={(): void => { void onCancelRun(r.id, true); }}>
                Force Cancel
              </Button>
            )}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

export function RunsAdmin(props: Readonly<{ runs: DataItem[]; queueMeta?: JsonRecord | null; handleCancelRun: (runId: string, force?: boolean) => Promise<void>; }>): React.JSX.Element {
  const { runs, queueMeta = null, handleCancelRun } = props;
  const [queue, setQueue] = useState<QueueStats | null>(null);
  useEffect((): (() => void) => {
    let cancelled = false;
    fetchApi("/api/v2/admin/system-info")
      .then((response: unknown): void => {
        if (cancelled) return;
        const worker = (response as { data?: { worker?: Record<string, unknown> } }).data?.worker;
        if (worker === undefined) return;
        const limit = worker["run-concurrency-limit"];
        const executing = worker["local-runs-executing"];
        const queued = worker["runs-queued"];
        if (typeof limit !== "number" || typeof executing !== "number") return;
        // Null queued means the backend read failed: show the rest and mark
        // the queue count unknown rather than rendering a false 0.
        if (queued !== null && typeof queued !== "number") return;
        setQueue({ limit, executing, queued });
      })
      .catch((): void => {
        // Advisory summary only; the table below stands on its own.
      });
    return (): void => { cancelled = true; };
  }, []);
  return (
    <Card>
      <CardHeader variant="section">
        <CardTitle className="text-lg">System run queue</CardTitle>
        <CardDescription>Monitor and control active execution runs</CardDescription>
        {queue !== null && (
          <p className="mt-2 text-sm text-muted-foreground">Concurrency limit {queue.limit} · {queue.executing} executing · {queue.queued === null ? "queued unknown" : `${String(queue.queued)} queued`} (limit from TERRENCE_RUN_CONCURRENCY)</p>
        )}
        {queueMeta !== null && ((): React.JSX.Element => {
          const capacity = record(queueMeta["capacity"]);
          const pools = capacity !== null && Array.isArray(capacity["pools"])
            ? capacity["pools"].map(record).filter((pool): pool is JsonRecord => pool !== null)
            : [];
          const available = pools.reduce((total, pool): number => total + numberValue(pool["available-agents"]), 0);
          const queuedJobs = pools.reduce((total, pool): number => total + numberValue(pool["queued-jobs"]), 0);
          const snapshot = typeof queueMeta["snapshot-at"] === "string" ? queueMeta["snapshot-at"] : null;
          const controls = record(queueMeta["controls"]);
          return (
            <div className="mt-3 rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
              <div className="font-medium text-foreground">Capacity snapshot</div>
              <div>{available} available agent{available === 1 ? "" : "s"} · {queuedJobs} queued agent job{queuedJobs === 1 ? "" : "s"}{snapshot === null ? "" : ` · observed ${new Date(snapshot).toLocaleTimeString()}`}</div>
              {controls?.["reprioritize-supported"] === false && (
                <div className="mt-1 text-xs">Queued work keeps scheduler order; reprioritization is unavailable.</div>
              )}
            </div>
          );
        })()}
      </CardHeader>
      <CardContent>
        <div className="rounded-md border overflow-x-auto">
          <Table className="w-full text-left text-sm">
            <TableHeader className="bg-muted border-b text-muted-foreground font-medium">
              <TableRow>
                <TableHead className="px-4 py-3">Run ID</TableHead>
                <TableHead className="px-4 py-3">Status</TableHead>
                <TableHead className="px-4 py-3">Message</TableHead>
                <TableHead className="px-4 py-3">Queue explanation</TableHead>
                <TableHead className="px-4 py-3">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y">
              {runs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                    No active runs found.
                  </TableCell>
                </TableRow>
              ) : (
                runs.map((r): React.JSX.Element => (
                  <RunQueueRow key={r.id} r={r} onCancelRun={handleCancelRun} />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
};
