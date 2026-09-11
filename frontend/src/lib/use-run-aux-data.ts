import { useEffect, useState } from "react";
import { fetchApi } from "./api";
import { taskOutcomeLabel, type RunProvenanceManifest } from "./run-detail-format";
import type { RunResource } from "./run-view-state";
import { isString } from "./type-guards";

/**
 * Speculative plans never apply (issue #603): the run row only carries
 * plan-only, so resolve the speculative flag from its configuration
 * version. Best effort; a failed lookup simply shows no badge.
 */
export function useSpeculativeRun(runId: string, run: RunResource | null): boolean {
  const [speculativeRun, setSpeculativeRun] = useState(false);
  const planOnlyRun = run?.attributes["plan-only"] === true;
  const cvId = run?.relationships?.["configuration-version"]?.data?.id ?? null;

  useEffect((): (() => void) => {
    setSpeculativeRun(false);
    if (!planOnlyRun || cvId === null) return (): void => undefined;
    const controller = new AbortController();
    fetchApi(`/api/v2/configuration-versions/${encodeURIComponent(cvId)}`, { signal: controller.signal })
      .then((data: unknown): void => {
        if (controller.signal.aborted) return;
// SAFETY: the configuration-version endpoint returns the JSON:API envelope; speculative is read as unknown below.
        const attrs = (data as { data?: { attributes?: { speculative?: unknown } } }).data?.attributes;
        setSpeculativeRun(attrs?.speculative === true);
      })
      .catch((): void => undefined);
    return (): void => { controller.abort(); };
  }, [runId, planOnlyRun, cvId]);

  return speculativeRun;
}

export function useTaskOutcome(runId: string): string {
  const [taskOutcome, setTaskOutcome] = useState("No task result");

  useEffect((): (() => void) => {
    const controller = new AbortController();
    setTaskOutcome("Loading…");
    fetchApi(`/api/v2/runs/${encodeURIComponent(runId)}/task-stages`, { signal: controller.signal })
      .then((payload: unknown): void => {
        if (controller.signal.aborted) return;
        setTaskOutcome(taskOutcomeLabel((payload as { data?: unknown }).data));
      })
      .catch((): void => {
        if (!controller.signal.aborted) setTaskOutcome("Unavailable");
      });
    return (): void => { controller.abort(); };
  }, [runId]);

  return taskOutcome;
}

export type ProvenanceState = Readonly<{
  provenanceManifest: RunProvenanceManifest | null;
  provenanceError: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The provenance panel dereferences engine/configuration/inputState/
 * variables/sandbox unconditionally, so a partial manifest (e.g. `{}`)
 * would crash the render. Validate the full read shape before storing it.
 */
function isProvenanceManifest(value: unknown): value is RunProvenanceManifest {
  if (!isRecord(value)) return false;
  const engine = value["engine"];
  const configuration = value["configuration"];
  if (!isRecord(engine) || !isString(engine["binary"])) return false;
  if (!isRecord(configuration) || !isString(configuration["digest"])) return false;
  if (!isRecord(value["inputState"])) return false;
  if (!Array.isArray(value["variables"])) return false;
  if (!isRecord(value["sandbox"])) return false;
  const rerun = value["rerun"];
  return rerun === undefined
    || (isRecord(rerun) && isString(rerun["mode"]) && Array.isArray(rerun["changedSinceSource"]));
}

export function useProvenanceManifest(runId: string): ProvenanceState {
  const [provenanceManifest, setProvenanceManifest] = useState<RunProvenanceManifest | null>(null);
  const [provenanceError, setProvenanceError] = useState("");

  useEffect((): (() => void) => {
    const controller = new AbortController();
    setProvenanceManifest(null);
    setProvenanceError("");
    fetchApi(`/api/v2/runs/${encodeURIComponent(runId)}/provenance`, { signal: controller.signal })
      .then((payload: unknown): void => {
        if (controller.signal.aborted) return;
        const data = (payload as { data?: { attributes?: { manifest?: unknown } } }).data?.attributes?.manifest;
        if (data === undefined || data === null) return;
        if (!isProvenanceManifest(data)) {
          setProvenanceError("The provenance manifest was incomplete.");
          return;
        }
        setProvenanceManifest(data);
      })
      .catch((error: unknown): void => {
        if (!controller.signal.aborted) setProvenanceError(error instanceof Error ? error.message : String(error));
      });
    return (): void => { controller.abort(); };
  }, [runId]);

  return { provenanceManifest, provenanceError };
}
