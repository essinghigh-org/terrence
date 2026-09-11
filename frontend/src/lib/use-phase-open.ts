import { useEffect, useRef, useState } from "react";
import { resolvePhaseAutoOpen } from "./run-detail-model";

export type PhaseOpen = Readonly<{
  planIsOpen: boolean;
  applyIsOpen: boolean;
  setPlanExpanded: (open: boolean) => void;
  setApplyExpanded: (open: boolean) => void;
  planOpenRendered: { current: boolean };
  applyOpenRendered: { current: boolean };
}>;

/**
 * Plan/apply disclosure state. The apply section opens itself once execution
 * starts, while preserving any explicit disclosure choice the user made.
 */
export function usePhaseOpen(
  runId: string,
  runStatus: string | undefined,
  planStatus: string,
  applyStatus: string,
): PhaseOpen {
  const [planExpanded, setPlanExpanded] = useState<boolean | null>(null);
  const [applyExpanded, setApplyExpanded] = useState<boolean | null>(null);
  const applyExecutionStarted = runStatus === "applying" || applyStatus === "running";
  // Same-route navigation (run A -> run B) keeps this hook mounted: an
  // explicit choice made on A must not leak into B. Declared first so the
  // auto-open rule below still applies to the fresh run in the same commit.
  useEffect((): void => {
    setPlanExpanded(null);
    setApplyExpanded(null);
  }, [runId]);
  useEffect((): void => {
    // Auto-open on execution start, but never override an explicit user
    // choice: a deliberate collapse stays collapsed.
    if (applyExecutionStarted) setApplyExpanded((current): boolean | null => current ?? true);
  }, [runId, applyExecutionStarted]);
  const planOpenRendered = useRef<boolean>(false);
  const applyOpenRendered = useRef<boolean>(false);
  const { autoPlanOpen, autoApplyOpen } = resolvePhaseAutoOpen({ planStatus, applyStatus });
  const planIsOpen = planExpanded ?? autoPlanOpen;
  const applyIsOpen = applyExpanded ?? autoApplyOpen;
  return {
    planIsOpen,
    applyIsOpen,
    setPlanExpanded,
    setApplyExpanded,
    planOpenRendered,
    applyOpenRendered,
  };
}
