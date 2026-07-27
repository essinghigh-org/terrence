import { useEffect, useState, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { CheckCircle2, XCircle, Clock, AlertCircle, ChevronDown, ExternalLink } from "lucide-react";

export function RunDetail() {
  const { orgName, workspaceName, runId } = useParams();
  const [run, setRun] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<string>("");
  const logsRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    loadRun();
    const interval = setInterval(loadRun, 3000);
    return () => clearInterval(interval);
  }, [runId]);

  async function loadRun() {
    try {
      const data = await fetchApi(`/api/v2/runs/${runId}`);
      setRun(data.data);

      if (data.data.attributes.status !== 'pending') {
        const logData = await fetchApi(`/api/v2/runs/${runId}/logs`);
        if (logData && logData.logs) {
           setLogs(logData.logs.map((l: any) => l.message).join(""));
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs]);

  async function handleApply() {
    try {
      await fetchApi(`/api/v2/runs/${runId}/actions/apply`, { method: "POST" });
      loadRun();
    } catch (err) {
      alert("Failed to apply run");
    }
  }

  async function handleDiscard() {
    try {
      await fetchApi(`/api/v2/runs/${runId}/actions/discard`, { method: "POST" });
      loadRun();
    } catch (err) {
      alert("Failed to discard run");
    }
  }

  if (loading && !run) return <div className="p-8 text-gray-500">Loading run...</div>;
  if (!run) return <div className="p-8 text-gray-500">Run not found</div>;

  const status = run.attributes.status;
  const isPending = status === 'pending';
  const isPlanning = status === 'planning';
  const isPlanned = status === 'planned';
  const isApplying = status === 'applying';
  const isApplied = status === 'applied';
  const isErrored = status === 'errored' || status === 'failed';

  return (
    <div className="max-w-full w-full">
      {/* Breadcrumbs */}
      <div className="text-xs text-gray-500 mb-2 flex items-center gap-1.5 font-medium">
        <Link to={`/app/${orgName}`} className="hover:underline">{orgName}</Link>
        <span className="text-gray-300">/</span>
        <Link to={`/app/${orgName}/workspaces/${workspaceName}`} className="hover:underline">{workspaceName}</Link>
        <span className="text-gray-300">/</span>
        <span className="text-gray-900">Runs</span>
        <span className="text-gray-300">/</span>
        <span className="text-gray-900 font-mono">{runId}</span>
      </div>

      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight mb-2">
            {run.attributes.message || "Manual run"}
          </h1>
          <div className="flex items-center gap-4 text-[13px] text-gray-600">
             <div className="flex items-center gap-1.5">
               <div className="h-5 w-5 rounded bg-gray-200 flex items-center justify-center text-[10px] font-bold text-gray-600">U</div>
               <span>User triggered</span>
             </div>
             <span>•</span>
             <span>Created {new Date(run.attributes["created-at"]).toLocaleString()}</span>
          </div>
        </div>

        {isPlanned && (
          <div className="flex gap-3">
            <Button variant="outline" onClick={handleDiscard} className="bg-white">Discard run</Button>
            <Button onClick={handleApply} className="bg-[#2962ff] hover:bg-[#1a4bcf] text-white">Confirm & Apply</Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2">
          {/* Run timeline UI mimicking screenshot */}
          <div className="bg-white border border-gray-200 rounded-md shadow-sm mb-6 overflow-hidden">
             {/* Plan step */}
             <div className="border-b border-gray-200">
                <div className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-gray-50">
                   <div className="flex items-center gap-3">
                      {isPending ? <Clock className="h-5 w-5 text-gray-400" /> :
                       isPlanning ? <Clock className="h-5 w-5 text-blue-500" /> :
                       isErrored && !isApplying ? <XCircle className="h-5 w-5 text-red-500" /> :
                       <CheckCircle2 className="h-5 w-5 text-emerald-500" />}
                      <span className="font-semibold text-gray-900">Plan</span>
                   </div>
                   <div className="flex items-center gap-4">
                      {run.attributes["has-changes"] !== undefined && (
                        <span className="text-sm text-gray-600">
                           {run.attributes["has-changes"] ? "Changes to apply" : "No changes"}
                        </span>
                      )}
                      <ChevronDown className="h-4 w-4 text-gray-400" />
                   </div>
                </div>

                {/* Embedded Terminal for Plan */}
                {(!isPending) && (
                  <div className="bg-[#111315] p-4 text-gray-300 font-mono text-[13px] leading-relaxed border-t border-gray-200 relative overflow-hidden">
                     <pre ref={logsRef} className="max-h-[400px] overflow-y-auto whitespace-pre-wrap">{logs || "Initializing..."}</pre>
                     <div className="absolute top-4 right-4 flex gap-2">
                        <button className="bg-white/10 hover:bg-white/20 text-white rounded p-1.5 transition-colors">
                           <ExternalLink className="h-3.5 w-3.5" />
                        </button>
                     </div>
                  </div>
                )}
             </div>

             {/* Cost Estimation step */}
             <div className="border-b border-gray-200">
                <div className="flex items-center justify-between px-5 py-4">
                   <div className="flex items-center gap-3">
                      <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                      <span className="font-semibold text-gray-900">Cost estimation</span>
                   </div>
                   <div className="flex items-center gap-3 text-xs">
                      <span className="text-gray-500">Monthly Delta:</span>
                      <span className="font-mono font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-100">$0.00 / mo</span>
                   </div>
                </div>
             </div>

             {/* Policy Check step */}
             <div className="border-b border-gray-200">
                <div className="flex items-center justify-between px-5 py-4">
                   <div className="flex items-center gap-3">
                      {status === 'policy_soft_failed' ? (
                        <AlertCircle className="h-5 w-5 text-amber-500" />
                      ) : (
                        <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                      )}
                      <span className="font-semibold text-gray-900">Policy check</span>
                   </div>
                   {status === 'policy_soft_failed' ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded font-medium">Soft Failed</span>
                        <Button size="sm" variant="outline" onClick={async () => {
                           try {
                             await fetchApi(`/api/v2/runs/${runId}/actions/override-policy`, { method: "POST" });
                             loadRun();
                           } catch (err) { alert("Failed to override policy"); }
                        }}>
                          Override Policy
                        </Button>
                      </div>
                   ) : (
                      <span className="text-xs bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded font-medium border border-emerald-100">PASSED</span>
                   )}
                </div>
             </div>

             {/* Apply step */}
             <div>
                <div className="flex items-center justify-between px-5 py-4">
                   <div className="flex items-center gap-3">
                      {isApplied ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> :
                       isApplying ? <Clock className="h-5 w-5 text-blue-500" /> :
                       isPlanned ? <AlertCircle className="h-5 w-5 text-orange-500" /> :
                       <div className="h-5 w-5 rounded-full border-2 border-gray-300 flex items-center justify-center" />}
                      <span className={`font-semibold ${isApplied || isApplying || isPlanned ? 'text-gray-900' : 'text-gray-500'}`}>Apply</span>
                   </div>
                   {isPlanned && <span className="text-sm text-orange-600 font-medium bg-orange-50 px-2 py-0.5 rounded border border-orange-200">Needs confirmation</span>}
                </div>
             </div>
          </div>
        </div>

        <div className="col-span-1">
          <div className="bg-white border border-gray-200 rounded-md shadow-sm">
            <div className="px-4 py-3 border-b border-gray-200">
              <h3 className="text-sm font-semibold text-gray-900">Run Details</h3>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Status</div>
                <div className="text-[13px] text-gray-900 font-medium capitalize">
                   {status.replace(/_/g, ' ')}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Workspace</div>
                <div className="text-[13px] text-blue-600 hover:underline cursor-pointer font-medium">
                   {workspaceName}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Auto-apply</div>
                <div className="text-[13px] text-gray-900">
                   {run.attributes["auto-apply"] ? "Enabled" : "Disabled"}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
