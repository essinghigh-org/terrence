import { useEffect, useState } from "react";
import { fetchApi } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
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
};

type StateHistoryProps = {
  workspaceId: string;
}

export function StateHistory({ workspaceId }: StateHistoryProps): React.JSX.Element {
  const [states, setStates] = useState<StateItem[]>([]);
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [loadingStateId, setLoadingStateId] = useState<string | null>(null);

  useEffect((): void => {
    fetchApi(`/workspaces/${workspaceId}/state-versions`)
      .then((res: unknown): void => {
        const data = res as { data?: StateItem[] };
        if (data.data != null) setStates(data.data);
      })
      .catch((err: unknown): void => { console.error(err); });
  }, [workspaceId]);

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
            {states.map((s: StateItem): React.JSX.Element => (
              <TableRow key={s.id}>
                <TableCell className="font-bold">#{s.attributes["serial"] as number}</TableCell>
                <TableCell className="font-mono text-xs">{s.id}</TableCell>
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
