import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchApi } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";

interface RunListProps {
  workspaceId: string;
  orgName: string;
  workspaceName: string;
}

export function RunList({ workspaceId, orgName, workspaceName }: RunListProps) {
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const loadRuns = async (signal?: AbortSignal) => {
    try {
      const res = await fetchApi(`/workspaces/${workspaceId}/runs`, { signal });
      setRuns(res.data || []);
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.error("Failed to load runs", err);
      }
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    loadRuns(controller.signal);

    const timer = setInterval(() => loadRuns(controller.signal), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [workspaceId]);

  const triggerRun = async () => {
    setLoading(true);
    try {
      await fetchApi(`/runs`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "runs",
            attributes: { message: "Queued manually via UI" },
            relationships: {
              workspace: { data: { id: workspaceId, type: "workspaces" } },
            },
          },
        }),
      });
      await loadRuns();
    } catch (err: any) {
      alert(err.message || "Failed to trigger run");
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      pending: "bg-yellow-100 text-yellow-800 border-yellow-300",
      planning: "bg-blue-100 text-blue-800 border-blue-300 animate-pulse",
      planned: "bg-purple-100 text-purple-800 border-purple-300",
      applying: "bg-indigo-100 text-indigo-800 border-indigo-300 animate-pulse",
      applied: "bg-emerald-100 text-emerald-800 border-emerald-300",
      errored: "bg-rose-100 text-rose-800 border-rose-300",
      canceled: "bg-gray-100 text-gray-800 border-gray-300",
      discarded: "bg-gray-100 text-gray-800 border-gray-300",
    };
    return (
      <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${styles[status] || "bg-gray-100 text-gray-800"}`}>
        {status}
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Runs</h2>
        <Button onClick={triggerRun} disabled={loading}>
          {loading ? "Queueing..." : "Start new run"}
        </Button>
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Run ID</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">
                  <Link to={`/app/${orgName}/workspaces/${workspaceName}/runs/${r.id}`} className="text-blue-600 hover:underline">
                    {r.id.substring(0, 8)}...
                  </Link>
                </TableCell>
                <TableCell>{r.attributes.message}</TableCell>
                <TableCell>{getStatusBadge(r.attributes.status)}</TableCell>
                <TableCell>
                  <Link to={`/app/${orgName}/workspaces/${workspaceName}/runs/${r.id}`}>
                    <Button variant="outline" size="sm">
                      View details
                    </Button>
                  </Link>
                </TableCell>
              </TableRow>
            ))}
            {runs.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-gray-500 py-8">
                  No runs recorded for this workspace.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
