import { useEffect, useState } from "react";

import { ApiError, fetchApi } from "@/lib/api";

type AgentPoolAttributes = Readonly<{
  name: string;
  "organization-scoped"?: boolean;
}>;

export type AgentPoolResource = Readonly<{
  id: string;
  attributes: AgentPoolAttributes;
}>;

type AgentPoolResponse = Readonly<{
  data?: AgentPoolResource[];
}>;

export type AgentPoolLoadState = Readonly<{
  pools: AgentPoolResource[];
  loading: boolean;
  error: string;
}>;

/** Load organization agent pools for settings that can reference a pool. */
export function useAgentPools(
  orgName: string,
  enabled: boolean,
): AgentPoolLoadState {
  const [pools, setPools] = useState<AgentPoolResource[]>([]);
  const [loading, setLoading] = useState(enabled && orgName !== "");
  const [error, setError] = useState("");

  useEffect((): (() => void) => {
    const controller = new AbortController();
    if (!enabled || orgName === "") {
      setPools([]);
      setLoading(false);
      setError("");
      return (): void => { controller.abort(); };
    }

    setPools([]);
    setLoading(true);
    setError("");
    void fetchApi<AgentPoolResponse>(
      `/organizations/${encodeURIComponent(orgName)}/agent-pools`,
      { signal: controller.signal },
    ).then((response): void => {
      if (controller.signal.aborted) return;
      setPools(Array.isArray(response.data) ? response.data : []);
      setLoading(false);
    }).catch((reason): void => {
      if (controller.signal.aborted) return;
      setLoading(false);
      setError(
        reason instanceof ApiError && reason.status === 404
          ? "Agent pools are unavailable. Ask an organization administrator for agent-pool access."
          : reason instanceof Error ? reason.message : "Could not load agent pools.",
      );
    });

    return (): void => { controller.abort(); };
  }, [enabled, orgName]);

  return { pools, loading, error };
}
