import { useEffect, useState, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { fetchApi } from "@/lib/api";
import { Button } from "@/components/ui/button";

export function RunDetail() {
  const { orgName, workspaceName, runId } = useParams();
  const [run, setRun] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [loadingAction, setLoadingAction] = useState(false);
  const isTerminalRef = useRef(false);

  const fetchRunData = async (signal?: AbortSignal) => {
    if (!runId || isTerminalRef.current) return;
    try {
      const runRes = await fetchApi(`/runs/${runId}`, { signal });
      setRun(runRes.data);

      const status = runRes.data?.attributes?.status;
      if (["applied", "errored", "canceled", "discarded"].includes(status)) {
        isTerminalRef.current = true;
      }

      const logsRes = await fetchApi(`/runs/${runId}/logs`, { signal });
      setLogs(logsRes.data || []);
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.error("Failed to fetch run data", err);
      }
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    isTerminalRef.current = false;
    fetchRunData(controller.signal);

    const interval = setInterval(() => {
      if (!isTerminalRef.current) {
        fetchRunData(controller.signal);
      } else {
        clearInterval(interval);
      }
    }, 2000);

    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [runId]);

  const executeRunAction = async (action: "apply" | "discard" | "cancel", failMsg: string) => {
    setLoadingAction(true);
    try {
      await fetchApi(`/runs/${runId}/actions/${action}`, { method: "POST" });
      isTerminalRef.current = false;
      await fetchRunData();
    } catch (err: any) {
      alert(err.message || failMsg);
    } finally {
      setLoadingAction(false);
    }
  };

  if (!run) return <div className="p-8">Loading run details...</div>;

  const status = run.attributes.status;

  return (
    <div className="p-8 max-w-6xl mx-auto flex flex-col gap-6">
      <div className="flex justify-between items-center border-b pb-4">
        <div>
          <div className="text-sm text-gray-500 flex items-center gap-2">
            <Link to={`/app/${orgName}`} className="hover:underline">{orgName}</Link> /
            <Link to={`/app/${orgName}/workspaces/${workspaceName}`} className="hover:underline">{workspaceName}</Link> /
            <span>Runs</span>
          </div>
          <h1 className="text-2xl font-bold mt-1">Run {runId?.substring(0, 8)}</h1>
          <p className="text-sm text-gray-600 mt-0.5">{run.attributes.message}</p>
        </div>

        <div className="flex items-center gap-3">
          {status === "planned" && (
            <>
              <Button onClick={() => executeRunAction("apply", "Failed to apply run")} disabled={loadingAction} className="bg-emerald-600 hover:bg-emerald-700">
                Confirm & Apply
              </Button>
              <Button variant="outline" onClick={() => executeRunAction("discard", "Failed to discard run")} disabled={loadingAction}>
                Discard Run
              </Button>
            </>
          )}
          {(status === "pending" || status === "planning" || status === "applying") && (
            <Button variant="destructive" onClick={() => executeRunAction("cancel", "Failed to cancel run")} disabled={loadingAction}>
              Cancel Run
            </Button>
          )}
        </div>
      </div>

      {/* Progress Timeline */}
      <div className="flex items-center justify-between border rounded-lg p-4 bg-gray-50/50">
        {["pending", "planning", "planned", "applying", "applied"].map((step, idx) => {
          const isCurrent = status === step;
          const isDone =
            status === "applied" ||
            (status === "applying" && ["pending", "planning", "planned"].includes(step)) ||
            (status === "planned" && ["pending", "planning"].includes(step)) ||
            (status === "planning" && step === "pending");

          const isErrored = status === "errored" && (step === "planning" || step === "applying");

          return (
            <div key={step} className="flex items-center gap-2">
              <div
                className={`size-7 rounded-full flex items-center justify-center text-xs font-bold ${
                  isCurrent
                    ? "bg-blue-600 text-white animate-pulse"
                    : isDone
                    ? "bg-emerald-600 text-white"
                    : isErrored
                    ? "bg-rose-600 text-white"
                    : "bg-gray-200 text-gray-600"
                }`}
              >
                {idx + 1}
              </div>
              <span className={`text-sm font-medium capitalize ${isCurrent ? "text-blue-600 font-bold" : "text-gray-600"}`}>
                {step}
              </span>
            </div>
          );
        })}
      </div>

      {/* Terminal Log Output Viewer */}
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Execution Output</h2>
        <div className="bg-slate-950 text-slate-100 p-4 rounded-lg font-mono text-xs overflow-x-auto min-h-[300px] max-h-[600px] space-y-1">
          {logs.map((log, index) => (
            <div key={index} className="whitespace-pre-wrap flex gap-3">
              <span className="text-slate-500 uppercase select-none w-12 flex-shrink-0">[{log.attributes.phase}]</span>
              <span className="text-slate-200">{log.attributes["output-text"]}</span>
            </div>
          ))}
          {logs.length === 0 && <div className="text-slate-500 italic">Waiting for log streaming...</div>}
        </div>
      </div>
    </div>
  );
}
