import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Filter, CheckCircle2, XCircle, Clock, AlertCircle } from "lucide-react";
import { Button } from "../components/ui/button";

export function RunList({ workspaceId, orgName, workspaceName }: { workspaceId: string, orgName?: string, workspaceName?: string }) {
  const params = useParams();
  orgName = orgName || params.orgName;
  workspaceName = workspaceName || params.workspaceName;

  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadRuns();
  }, [workspaceId]);

  async function loadRuns() {
    try {
      const data = await fetchApi(`/api/v2/workspaces/${workspaceId}/runs`);
      setRuns(data.data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  const getStatusIcon = (status: string) => {
    switch(status) {
      case 'applied':
      case 'planned_and_finished':
        return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
      case 'errored':
      case 'failed':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'planning':
      case 'applying':
      case 'pending':
        return <Clock className="h-4 w-4 text-blue-500" />;
      case 'planned':
        return <AlertCircle className="h-4 w-4 text-orange-500" />;
      default:
        return <CheckCircle2 className="h-4 w-4 text-gray-400" />;
    }
  };

  const getStatusText = (status: string) => {
    const map: Record<string, string> = {
      'applied': 'Applied',
      'planned_and_finished': 'Planned and finished',
      'errored': 'Errored',
      'failed': 'Failed',
      'planning': 'Planning',
      'applying': 'Applying',
      'pending': 'Pending',
      'planned': 'Needs confirmation',
      'canceled': 'Canceled',
      'discarded': 'Discarded'
    };
    return map[status] || status;
  };

  if (loading) return <div className="py-8 text-center text-gray-500">Loading runs...</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
           <Button variant="outline" className="h-9 px-3 text-sm text-gray-700 font-medium rounded-[4px] border-gray-300 shadow-sm flex items-center gap-2 bg-white hover:bg-gray-50">
             <Filter className="h-4 w-4 text-gray-500" /> Filter runs
           </Button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-md overflow-hidden">
        {runs.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            <h3 className="text-base text-gray-900 font-medium mb-1">No runs yet</h3>
            <p className="text-sm mb-4">There is no run history for this workspace.</p>
            <Button className="bg-[#2962ff] hover:bg-[#1a4bcf] text-white rounded-[4px] h-9 px-4 shadow-none" onClick={async () => { await fetchApi("/api/v2/runs", { method: "POST", body: JSON.stringify({ data: { type: "runs", relationships: { workspace: { data: { type: "workspaces", id: workspaceId } } } } }) }); loadRuns(); }}>
              Start new run
            </Button>
          </div>
        ) : (
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="bg-[#f9fafb] border-b border-gray-200 text-gray-800 font-semibold text-xs tracking-wide">
                <th className="px-4 py-3 border-r border-gray-200">Run</th>
                <th className="px-4 py-3 border-r border-gray-200">Status</th>
                <th className="px-4 py-3 border-r border-gray-200">Source</th>
                <th className="px-4 py-3 border-r border-gray-200">Triggered by</th>
                <th className="px-4 py-3">Time</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b border-gray-200 hover:bg-gray-50 group transition-colors">
                  <td className="px-4 py-4 border-r border-gray-200">
                    <Link
                      to={`/app/${orgName}/workspaces/${workspaceName}/runs/${run.id}`}
                      className="text-blue-700 font-medium hover:underline text-[13px] block mb-0.5"
                    >
                      {run.attributes.message || "Manual run"}
                    </Link>
                    <div className="text-[11px] text-gray-500 font-mono">
                      {run.id}
                    </div>
                  </td>
                  <td className="px-4 py-4 border-r border-gray-200">
                     <div className="flex items-center gap-2 text-[13px] text-gray-900 font-medium">
                        {getStatusIcon(run.attributes.status)}
                        {getStatusText(run.attributes.status)}
                     </div>
                  </td>
                  <td className="px-4 py-4 border-r border-gray-200 text-[13px] text-gray-600">
                    UI/API
                  </td>
                  <td className="px-4 py-4 border-r border-gray-200">
                    <div className="flex items-center gap-2">
                       <div className="h-5 w-5 rounded bg-gray-200 flex items-center justify-center text-[10px] font-bold text-gray-600">U</div>
                       <span className="text-[13px] text-gray-600">User</span>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-[13px] text-gray-500">
                    {new Date(run.attributes["created-at"]).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
