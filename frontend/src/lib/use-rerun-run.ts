import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchApi } from "./api";
import { isString } from "./type-guards";

export type RerunRun = Readonly<{
  rerunPending: boolean;
  rerunError: string;
  rerunDialogOpen: boolean;
  setRerunDialogOpen: (open: boolean) => void;
  performRerun: (mode: "original" | "current") => Promise<void>;
}>;

export function useRerunRun(args: Readonly<{
  runId: string;
  workspaceId: string;
  workspacePath: string;
}>): RerunRun {
  const navigate = useNavigate();
  const [rerunPending, setRerunPending] = useState(false);
  const [rerunError, setRerunError] = useState("");
  const [rerunDialogOpen, setRerunDialogOpen] = useState(false);
  // Synchronous guard: state updates land on re-render, so two rapid clicks
  // could both pass the rerunPending check and queue duplicate runs.
  const rerunInFlightRef = useRef(false);

  const performRerun = async (mode: "original" | "current"): Promise<void> => {
    if (args.workspaceId === "" || rerunPending || rerunInFlightRef.current) return;
    rerunInFlightRef.current = true;
    setRerunPending(true);
    setRerunError("");
    try {
      const body = await fetchApi(`/api/v2/runs/${encodeURIComponent(args.runId)}/actions/rerun`, {
        method: "POST",
        body: JSON.stringify({ mode }),
      });
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const newRunId = (body as { data?: { id?: string } }).data?.id;
      if (isString(newRunId) && newRunId !== "") {
        void navigate(`${args.workspacePath}/runs/${encodeURIComponent(newRunId)}`);
      } else {
        setRerunError("The run was created but the response did not include a run id.");
      }
    } catch (err: unknown) {
      setRerunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRerunPending(false);
      setRerunDialogOpen(false);
      rerunInFlightRef.current = false;
    }
  };

  return { rerunPending, rerunError, rerunDialogOpen, setRerunDialogOpen, performRerun };
}
