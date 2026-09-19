import { useCallback, useEffect, useRef, useState } from "react";
import { fetchApi, fetchApiBlob } from "./api";

export type InsightRecord = Readonly<Record<string, unknown>>;
export type InsightResource = Readonly<{
  id: string;
  type: string;
  attributes: InsightRecord;
  relationships?: InsightRecord;
}>;
export type InsightCollection = Readonly<{
  data: readonly InsightResource[];
  page: number;
  pages: number;
  total: number | null;
}>;

export function isInsightRecord(value: unknown): value is InsightRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function record(value: unknown): InsightRecord {
  return isInsightRecord(value) ? value : {};
}

export function text(value: unknown, fallback = "Unavailable"): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function records(value: unknown): readonly InsightRecord[] {
  return Array.isArray(value) ? value.filter(isInsightRecord) : [];
}

function decodeResource(value: unknown): InsightResource {
  if (
    !isInsightRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["type"] !== "string" ||
    !isInsightRecord(value["attributes"])
  ) {
    throw new Error("The server returned an incomplete resource. No result can be inferred.");
  }
  return {
    id: value["id"],
    type: value["type"],
    attributes: value["attributes"],
    relationships: record(value["relationships"]),
  };
}

export function resourceDocument(value: unknown): InsightResource {
  return decodeResource(record(value)["data"]);
}

export function collectionDocument(value: unknown): InsightCollection {
  const body = record(value);
  if (!Array.isArray(body["data"]))
    throw new Error("The server returned an incomplete collection, not an empty result.");
  const pagination = record(record(body["meta"])["pagination"]);
  return {
    data: body["data"].map(decodeResource),
    page: numberValue(pagination["current-page"] ?? pagination["current_page"]) ?? 1,
    pages: numberValue(pagination["total-pages"] ?? pagination["total_pages"]) ?? 1,
    total: numberValue(pagination["total-count"] ?? pagination["total_count"]),
  };
}

export function objectDocument(value: unknown): InsightRecord {
  const data = record(value)["data"];
  if (!isInsightRecord(data)) throw new Error("The server returned an incomplete response.");
  return data;
}

export type InsightLoad<T> = Readonly<{
  data: T | null;
  loading: boolean;
  error: string;
  checkedAt: number | null;
  reload: () => void;
}>;

/** Keyed snapshots prevent old workspace/run responses flashing after navigation. */
export function useInsightResource<T>(
  endpoint: string | null,
  decode: (value: unknown) => T,
  refreshMs = 0,
): InsightLoad<T> {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<
    Readonly<{ key: string | null; data: T | null; loading: boolean; error: string; checkedAt: number | null }>
  >({
    key: endpoint,
    data: null,
    loading: endpoint !== null,
    error: "",
    checkedAt: null,
  });
  const reload = useCallback((): void => {
    setRevision((value): number => value + 1);
  }, []);
  useEffect((): (() => void) | undefined => {
    if (endpoint === null) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ key: endpoint, data: null, loading: true, error: "", checkedAt: null });
    void fetchApi(endpoint, { signal: controller.signal })
      .then((value: unknown): void => {
        const data = decode(value);
        if (!controller.signal.aborted)
          setState({ key: endpoint, data, loading: false, error: "", checkedAt: Date.now() });
      })
      .catch((error: unknown): void => {
        if (!controller.signal.aborted)
          setState({
            key: endpoint,
            data: null,
            loading: false,
            error: error instanceof Error ? error.message : "Request failed",
            checkedAt: null,
          });
      })
      .finally((): void => {
        if (refreshMs > 0 && !controller.signal.aborted) timer = setTimeout(reload, refreshMs);
      });
    return (): void => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [endpoint, decode, revision, reload, refreshMs]);
  if (state.key !== endpoint) return { data: null, loading: endpoint !== null, error: "", checkedAt: null, reload };
  return { ...state, reload };
}

export type InsightAction = Readonly<{
  busy: boolean;
  error: string;
  result: InsightResource | null;
  execute: (
    endpoint: string,
    attributes?: InsightRecord,
    method?: "POST" | "PATCH" | "DELETE",
  ) => Promise<InsightResource | null>;
}>;

/** Writes are explicit, single-flight, and never automatically replayed. */
export function useInsightAction(scope: string): InsightAction {
  const identity = useRef(scope);
  identity.current = scope;
  const mounted = useRef(true);
  const pending = useRef(false);
  const requestIdentity = useRef<Readonly<{ signature: string; key: string }> | null>(null);
  const [state, setState] = useState<
    Readonly<{ scope: string; busy: boolean; error: string; result: InsightResource | null }>
  >({ scope, busy: false, error: "", result: null });
  useEffect((): (() => void) => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  const execute = async (
    endpoint: string,
    attributes: InsightRecord = {},
    method: "POST" | "PATCH" | "DELETE" = "POST",
  ): Promise<InsightResource | null> => {
    if (pending.current) return null;
    pending.current = true;
    const requestedScope = scope;
    setState({ scope, busy: true, error: "", result: null });
    try {
      const body = JSON.stringify({ data: { attributes } });
      const signature = `${requestedScope}:${method}:${endpoint}:${body}`;
      if (requestIdentity.current?.signature !== signature)
        requestIdentity.current = { signature, key: crypto.randomUUID() };
      const value = await fetchApi(endpoint, {
        method,
        headers: { "Idempotency-Key": requestIdentity.current.key },
        ...(method === "DELETE" ? {} : { body }),
      });
      const result =
        method === "DELETE"
          ? { id: endpoint, type: "deletion-results", attributes: { status: "deleted" } }
          : resourceDocument(value);
      if (!mounted.current || identity.current !== requestedScope) return null;
      setState({ scope, busy: false, error: "", result });
      requestIdentity.current = null;
      return result;
    } catch (error: unknown) {
      if (mounted.current && identity.current === requestedScope)
        setState({
          scope,
          busy: false,
          error: error instanceof Error ? error.message : "Request failed",
          result: null,
        });
      return null;
    } finally {
      pending.current = false;
    }
  };
  return { ...(state.scope === scope ? state : { busy: false, error: "", result: null }), execute };
}

export async function downloadInsight(endpoint: string, filename: string): Promise<void> {
  const blob = await fetchApiBlob(endpoint);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout((): void => {
    URL.revokeObjectURL(url);
  }, 1000);
}
