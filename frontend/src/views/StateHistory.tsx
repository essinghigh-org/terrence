import { useEffect, useState } from "react";
import { fetchApi } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type StateHistoryProps = {
  workspaceId: string;
}

export function StateHistory({ workspaceId }: StateHistoryProps) {
  const [states, setStates] = useState<any[]>([]);
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [loadingStateId, setLoadingStateId] = useState<string | null>(null);

  useEffect(() => {
    fetchApi(`/workspaces/${workspaceId}/state-versions`)
      .then((res) => { setStates(res.data || []); })
      .catch(console.error);
  }, [workspaceId]);

  const handleViewJson = async (s: any) => {
    if (s.attributes?.state) {
      try {
        const parsed = typeof s.attributes.state === "string" ? JSON.parse(s.attributes.state) : s.attributes.state;
        setSelectedState(JSON.stringify(parsed, null, 2));
      } catch {
        setSelectedState(s.attributes.state);
      }
      return;
    }

    setLoadingStateId(s.id);
    try {
      const res = await fetchApi(`/state-versions/${s.id}`);
      const rawPayload = res.data?.attributes?.state || "{}";
      try {
        const parsed = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
        setSelectedState(JSON.stringify(parsed, null, 2));
      } catch {
        setSelectedState(rawPayload);
      }
    } catch (err: any) {
      alert(err.message || "Failed to load state version JSON");
    } finally {
      setLoadingStateId(null);
    }
  };

  const handleDownload = async (s: any) => {
    try {
      const rawText = await fetchApi(`/state-versions/${s.id}/download`);
      const payloadString = typeof rawText === "string" ? rawText : JSON.stringify(rawText, null, 2);
      const blob = new Blob([payloadString], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const serial = s.attributes?.serial ?? 1;
      a.download = `terraform-state-v${serial}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(err.message || "Failed to download state version");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">State Version History</h2>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Serial</TableHead>
              <TableHead>State Version ID</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {states.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-bold">#{s.attributes.serial}</TableCell>
                <TableCell className="font-mono text-xs">{s.id}</TableCell>
                <TableCell className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadingStateId === s.id}
                    onClick={async () => handleViewJson(s)}
                  >
                    {loadingStateId === s.id ? "Loading..." : "View JSON"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={async () => handleDownload(s)}>
                    Download State
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {states.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-gray-500 py-8">
                  No state versions recorded yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!selectedState} onOpenChange={() => { setSelectedState(null); }}>
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
