import { isNumber, isRecord, isString } from "../lib/type-guards";
import type { JsonObject, JsonValue } from "@/lib/json";
const API_BASE_URL = "/api/v2";
export const AUTH_CHANGED_EVENT = "terrence:auth-changed";
export const AUTH_EXPIRED_EVENT = "terrence:auth-expired";

// Legacy localStorage keys (tfe_token / tfe_token_expires_at /
// tfe_refreshable_session) are intentionally no longer written or read.
const SESSION_EXPIRED_KEY = "tfe_session_expired";

// Access tokens live in memory only (P2: keep access tokens out of
// localStorage). Browser sessions bootstrap through the HttpOnly refresh
// cookie on every page load; the legacy localStorage keys above are never
// written and only SESSION_EXPIRED_KEY remains there (non-secret toast
// marker that survives reloads).
let accessToken: string | null = null;
let accessTokenExpiry: number | null = null;
let refreshableSession = false;

function clearAuthMemory(): void {
  accessToken = null;
  accessTokenExpiry = null;
  refreshableSession = false;
}

/** localStorage access can throw (privacy modes, disabled storage). */
function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Best-effort: the session marker is cosmetic.
  }
}

function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Best-effort: nothing to clean up anyway when storage is unavailable.
  }
}

type ReadonlyResponse = Readonly<{
  readonly status: number;
  readonly headers: Readonly<Headers>;
  readonly json: () => Promise<JsonValue>;
  readonly text: () => Promise<string>;
}>;

type ReadonlyRequestInit = Readonly<{
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>> | readonly (readonly [string, string])[];
  readonly body?: BodyInit | null;

  readonly mode?: RequestMode;
  readonly credentials?: RequestCredentials;
  readonly cache?: RequestCache;
  readonly redirect?: RequestRedirect;
  readonly referrer?: string;
  readonly integrity?: string;
  readonly signal?: AbortSignal;
}>;

export class ApiError extends Error {
  public readonly status: number;

  /** Field-level 422 details, keyed as `{ "data.attributes.<field>": msg }`. */
  public readonly fieldErrors: Readonly<Record<string, string>>;

  public constructor(status: number, message: string, fieldErrors: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

/**
 * Extract field-level error details from a JSON:API error document. An
 * error entry with `source.pointer` (e.g. "/data/attributes/name") is
 * surfaced so UIs can render per-field feedback instead of a single blob
 * (26.9). Unparsable pointers are dropped.
 */
export function extractFieldErrors(rawErrors: readonly Readonly<JsonObject>[]) {
  const fieldErrors: Record<string, string> = {};
  for (const entry of rawErrors) {
    const source = entry["source"];
    const pointer = asRecordOrNull(source)?.["pointer"];
    if (!isString(pointer) || pointer === "") continue;
    const detail = isString(entry["detail"]) ? entry["detail"] : "";
    if (detail === "") continue;
    const path = pointer
      .replace(/^\/data\/attributes\//, "")
      .replace(/^\//, "");
    if (path !== "") fieldErrors[path] = detail;
  }
  return fieldErrors;
}


export function getAuthToken(): string | null {
  if (accessToken === null) return null;
  const expiresAt = accessTokenExpiry;
  if (expiresAt !== null && expiresAt <= Date.now() && !refreshableSession) {
    clearAuthMemory();
    storageSet(SESSION_EXPIRED_KEY, "true");
    return null;
  }
  return accessToken;
}

export function getAuthTokenExpiry(): number | null {
  return accessTokenExpiry;
}

export function isRefreshableSession(): boolean {
  return refreshableSession;
}

export function setAuthToken(
  token: string,
  expiresAt?: string | number | null,
  refreshable = false,
): void {
  accessToken = token;
  const normalizedExpiry = isString(expiresAt) ? Date.parse(expiresAt) : expiresAt;
  accessTokenExpiry = isNumber(normalizedExpiry) && Number.isFinite(normalizedExpiry)
    ? normalizedExpiry
    : null;
  refreshableSession = refreshable;
  storageRemove(SESSION_EXPIRED_KEY);
  window.dispatchEvent(new CustomEvent(AUTH_CHANGED_EVENT));
}

export function expireAuthSession(): void {
  const alreadyExpired = storageGet(SESSION_EXPIRED_KEY) === "true";
  clearAuthMemory();
  storageSet(SESSION_EXPIRED_KEY, "true");
  if (!alreadyExpired) window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
}

export function consumeAuthExpiry(): boolean {
  const expired = storageGet(SESSION_EXPIRED_KEY) === "true";
  storageRemove(SESSION_EXPIRED_KEY);
  return expired;
}

export async function readResponseBody(response: ReadonlyResponse): Promise<JsonValue> {
  if (response.status === 204) return null;
  const contentType = response.headers.get("Content-Type");
  if (contentType?.includes("json") === true) {
    return await response.json();
  }
  return await response.text();
}

type AccessTokenDocument = Readonly<{
  data?: Readonly<{
    attributes?: Readonly<{
      token?: unknown;
      "expired-at"?: unknown;
    }>;
  }>;
}>;

let refreshRequest: Promise<string | null> | null = null;

/**
 * Bootstrap the access token for a fresh page load. Browser sessions have
 * no token in memory yet; their only credential is the HttpOnly refresh
 * cookie, so the first refresh is attempted unconditionally (`force`).
 * Browser sessions bootstrap via the HttpOnly refresh cookie.
 * Returns null when there is no session, which leaves the
 * app at the login screen.
 */
export async function bootstrapAuth(): Promise<string | null> {
  if (accessToken !== null) return accessToken;
  // One-time purge of pre-memory legacy tokens that may still be present
  // in localStorage from older builds. They are no longer read, but
  // removing them avoids confusion and frees the slot.
  try {
    localStorage.removeItem("tfe_token");
    localStorage.removeItem("tfe_token_expires_at");
    localStorage.removeItem("tfe_refreshable_session");
  } catch {
    // storage unavailable — ignore
  }
  // All browser sessions now bootstrap exclusively via the HttpOnly refresh
  // cookie, so a stale personal token can no longer shadow the correct
  // session principal and 404 workspace runs.
  return refreshAccessToken(true).catch((): null => null);
}

async function refreshAccessToken(force = false): Promise<string | null> {
  if (!force && !refreshableSession) return null;
  refreshRequest ??= (async (): Promise<string | null> => {
    const response = await fetch(`${API_BASE_URL}/users/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      credentials: "same-origin",
    });
    if (!response.ok) return null;
    // SAFETY: /users/refresh returns the JSON:API access-token document; its
    // token and expired-at fields are typeof-checked below.
    const document = await readResponseBody(response) as AccessTokenDocument;
    const token = document.data?.attributes?.token;
    const expiresAt = document.data?.attributes?.["expired-at"];
    if (!isString(token) || token === "") return null;
    setAuthToken(
      token,
      isString(expiresAt) || isNumber(expiresAt) ? expiresAt : null,
      true,
    );
    return token;
  })().finally((): void => {
    refreshRequest = null;
  });
  return refreshRequest;
}

export async function fetchApi<T = unknown>(endpoint: string, options: ReadonlyRequestInit = {}): Promise<T> {
  // Absolute /api/* paths (v1 compatibility endpoints like /api/v1/metadata)
  // are used verbatim; everything else is relative to the v2 API base.
  const url = endpoint.startsWith("/api/")
    ? endpoint
    : `${API_BASE_URL}${endpoint}`;
  const send = async (accessToken: string | null): Promise<Response> => {
    // SAFETY: Headers accepts record and tuple-array shapes; the readonly
    // modifiers on the stored options are compile-time only.
    const headers = new Headers(options.headers as HeadersInit | undefined);
    if (!headers.has("Content-Type") && (options.body === undefined || options.body === null || isString(options.body))) {
      headers.set("Content-Type", "application/vnd.api+json");
    }
    if (accessToken !== null && accessToken !== "") {
      headers.set("Authorization", `Bearer ${accessToken}`);
    }
    return fetch(url, {
      // SAFETY: ReadonlyRequestInit is RequestInit with readonly modifiers;
      // spreading it is shape-identical at runtime.
      ...(options as RequestInit),
      headers,
    });
  };
  let token = getAuthToken();
  const expiresAt = getAuthTokenExpiry();
  if (
    token !== null
    && token !== ""
    && expiresAt !== null
    && expiresAt <= Date.now()
    && isRefreshableSession()
  ) {
    token = await refreshAccessToken().catch((): null => null) ?? token;
  }
  let response = await send(token);
  const canRefresh = response.status === 401
    && token !== null
    && token !== ""
    && isRefreshableSession()
    && !url.endsWith("/users/login")
    && !url.endsWith("/users/refresh")
    && !url.endsWith("/users/logout");
  if (canRefresh) {
    const refreshedToken = await refreshAccessToken().catch((): null => null);
    if (refreshedToken !== null) {
      response = await send(refreshedToken);
    }
  }
  // A stale in-memory token can yield 404 on workspace-scoped reads
  // when the principal lacks that workspace. Har review showed 5 rapid
  // 404s for /workspaces/ws-…/runs with Bearer VvQ… while the same URL
  // succeeded with HrTW… after a refresh. Retry a single 404 via the
  // refresh cookie when in a refreshable session so the correct principal
  // is picked up without surfacing "Run history may be out of date".
  const canRefreshOnWorkspace404 = response.status === 404
    && token !== null
    && token !== ""
    && isRefreshableSession()
    && /\/api\/v2\/workspaces\/[^/]+\/(runs|state-versions|vars|varsets|resources|dependency-graph|current-state-version-outputs|readme)$/.test(url.split("?")[0] ?? url)
    && !url.endsWith("/users/login")
    && !url.endsWith("/users/refresh")
    && !url.endsWith("/users/logout");
  if (canRefreshOnWorkspace404) {
    const refreshedToken = await refreshAccessToken().catch((): null => null);
    if (refreshedToken !== null && refreshedToken !== token) {
      response = await send(refreshedToken);
    }
  }

  if (!response.ok) {
    if (response.status === 401 && token !== null && token !== "" && !url.endsWith("/users/login")) {
      expireAuthSession();
    }
    const errors = await parseErrorBody(response);
    const firstErr = errors[0];
    const rawDetail = firstErr?.["detail"];
    const rawTitle = firstErr?.["title"];
    const detail = isString(rawDetail) ? rawDetail : null;
    const title = isString(rawTitle) ? rawTitle : null;
    throw new ApiError(
      response.status,
      detail ?? title ?? `API request failed (${response.status})`,
      extractFieldErrors(errors),
    );
  }

  // SAFETY: callers declare the expected response contract via the type
  // argument; the raw body is decoded by the caller's boundary checks.
  return readResponseBody(response) as Promise<T>;
}

export async function fetchAllApiPages<T>(endpoint: string, signal?: Readonly<AbortSignal>): Promise<T[]> {
  const data: T[] = [];
  const visited = new Set<string>();
  let pageEndpoint: string | null = endpoint;

  while (pageEndpoint !== null && !visited.has(pageEndpoint)) {
    visited.add(pageEndpoint);
    // SAFETY: list endpoints return the JSON:API collection envelope; the
    // data array and pagination meta fields are checked below.
    const response = (await fetchApi(
      pageEndpoint,
      signal === undefined ? {} : { signal },
    )) as {
      data?: T[];
      meta?: { pagination?: JsonObject };
    };
    if (Array.isArray(response.data)) data.push(...response.data);

    const nextPage = response.meta?.pagination?.["next-page"];
    if (!isNumber(nextPage) || !Number.isSafeInteger(nextPage) || nextPage < 1) {
      pageEndpoint = null;
      continue;
    }
    const nextUrl: URL = new globalThis.URL(pageEndpoint, "http://terrence.local");
    nextUrl.searchParams.set("page[number]", String(nextPage));
    pageEndpoint = `${nextUrl.pathname}${nextUrl.search}`;
  }

  return data;
}

export type ExplainKind = "plan" | "apply";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const REASONING_EFFORT_SET = new Set<string>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** View an unknown value as a string-keyed record, or null when it is not an object. */
function asRecordOrNull(value: unknown): JsonObject | null {
  if (!isRecord(value)) return null;
  // SAFETY: the typeof-object guard is the boundary check; callers validate
  // individual fields with typeof before use.
  return value;
}

/** Narrow a backend reasoning-effort value to the known union, or null. */
function reasoningEffortValue(value: unknown): ReasoningEffort | null {
  // SAFETY: the set membership check is the boundary validation; unknown
  // backend values degrade to null so the UI renders the default effort.
  return isString(value) && REASONING_EFFORT_SET.has(value) ? value as ReasoningEffort : null;
}

/** Parse a JSON:API error document from a failed response, or [] when it is not JSON. */
async function parseErrorBody(response: Response): Promise<readonly JsonObject[]> {
  const errorBody = asRecordOrNull(await response.json().catch((): null => null));
  const rawErrors = errorBody !== null ? errorBody["errors"] : undefined;
  // SAFETY: Array.isArray is the boundary check; entries are only read via
  // typeof-validated string fields in extractFieldErrors below.
  return Array.isArray(rawErrors) ? rawErrors as JsonObject[] : [];
}

/**
 * SSE event emitted by the streaming run-explain endpoint. The backend relays
 * upstream deltas as `meta`, `thinking`, `content`, `done`, and `error`
 * events; cached generations are replayed under the same envelope (done
 * carries `cached: true`). All payloads are JSON.
 */
export type ExplainStreamEvent = Readonly<
  | { name: "meta"; data: Readonly<{ kind: ExplainKind; model: string; "reasoning-effort": ReasoningEffort | null }> }
  | { name: "thinking"; data: Readonly<{ text: string }> }
  | { name: "content"; data: Readonly<{ text: string }> }
  | { name: "content-reset"; data: Readonly<{ text: string }> }
  | { name: "done"; data: Readonly<{ model: string; "reasoning-effort": ReasoningEffort | null; "generated-at": string; cached?: boolean }> }
  | { name: "error"; data: Readonly<{ message: string }> }
  | { name: "progress"; data: Readonly<{ status: string; "job-id": string; runId: string; kind: ExplainKind; "created-at": string; "updated-at": string }> }
>;

/** GET the cached (or job-status) explanation envelope for a run. */
export async function fetchExplanation(runId: string, kind: ExplainKind): Promise<{ explanation: string; model: string; reasoningEffort: ReasoningEffort | null; generatedAt: string; cached: boolean; status?: string | undefined; jobId?: string | undefined } | null> {
  let resp: unknown;
  try {
    resp = await fetchApi(`/runs/${encodeURIComponent(runId)}/explain?kind=${encodeURIComponent(kind)}`);
  } catch (caught: unknown) {
    if (caught instanceof ApiError && caught.status === 404) return null;
    throw caught;
  }
  const data = (resp as { data?: { attributes?: Record<string, unknown> } } | null)?.data?.attributes;
  if (data === undefined || data === null || typeof data !== "object") return null;
  const d = data;
  if (typeof d["explanation"] === "string" && d["explanation"] !== "") {
    return { explanation: d["explanation"], model: typeof d["model"] === "string" ? d["model"] : "", reasoningEffort: reasoningEffortValue(d["reasoning-effort"]), generatedAt: typeof d["generated-at"] === "string" ? d["generated-at"] : new Date().toISOString(), cached: d["cached"] === true };
  }
  if (typeof d["status"] === "string") {
    return { explanation: "", model: "", reasoningEffort: reasoningEffortValue(d["reasoning-effort"]), generatedAt: typeof d["updated-at"] === "string" ? d["updated-at"] : "", cached: false, status: d["status"], jobId: typeof d["job-id"] === "string" ? d["job-id"] : undefined };
  }
  return null;
}

/** Enqueue a durable explanation job (non-streaming). Returns the job envelope. */
export async function enqueueExplanation(runId: string, kind: ExplainKind): Promise<{ status: string; jobId?: string | undefined }> {
  // SAFETY: the endpoint contract returns this envelope; the autofix stripped
  // a redundant cast that also carried the type for the narrowing below.
  const resp = (await fetchApi(
    `/runs/${encodeURIComponent(runId)}/explain`,
    { method: "POST", body: JSON.stringify({ data: { type: "plan-explanations", attributes: { kind } } }) },
  )) as { data?: { attributes?: Record<string, unknown> } };
  const attrs = resp?.data?.attributes;
  if (attrs !== undefined && typeof attrs["status"] === "string") return { status: attrs["status"], jobId: typeof attrs["job-id"] === "string" ? attrs["job-id"] : undefined };
  if (attrs !== undefined && typeof attrs["explanation"] === "string") return { status: "succeeded" };
  return { status: "queued" };
}

/**
 * Stream a run explanation from the AI explainer. Always asks for
 * `stream: true`; the backend answers through the SSE envelope whether it
 * regenerates or replays a cached generation, so callers have one parsing
 * path. Abort through `signal` to cancel (the backend relays the abort
 * upstream). Resolves on the terminal `done` event; rejects with ApiError on
 * HTTP errors and throws on a terminal `error` event.
 */
export async function streamExplain(
  runId: string,
  kind: ExplainKind,
  refresh: boolean,
  onEvent: (event: Readonly<ExplainStreamEvent>) => void,
  signal?: Readonly<AbortSignal>,
): Promise<void> {
  const url = `${API_BASE_URL}/runs/${encodeURIComponent(runId)}/explain`;
  // Same refresh-and-retry semantics as fetchApi: an expired token is
  // refreshed once and the request replayed before the session is expired.
  const send = async (accessToken: string | null): Promise<Response> => {
    const headers: HeadersInit = {
      "Content-Type": "application/vnd.api+json",
      ...(accessToken !== null ? { Authorization: `Bearer ${accessToken}` } : undefined),
    };
    // SAFETY: the request object is the same shape as RequestInit; the
    // as-assertion only drops the readonly modifiers for fetch's signature.
    return fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        data: {
          type: "plan-explanations",
          attributes: { kind, stream: true, ...(refresh ? { refresh: true } : undefined) },
        },
      }),
      signal,
    } as RequestInit);
  };
  let token = await prepareAuthToken();
  let response: Response;
  try {
    response = await send(token);
  } catch (caught: unknown) {
    if (signal?.aborted === true) return;
    throw new ApiError(0, caught instanceof Error ? caught.message : String(caught));
  }
  if (response.status === 401 && token !== null && token !== "" && isRefreshableSession()) {
    const refreshedToken = await refreshAccessToken().catch((): null => null);
    if (refreshedToken !== null) {
      token = refreshedToken;
      try {
        response = await send(refreshedToken);
      } catch (caught: unknown) {
        if (signal?.aborted === true) return;
        throw new ApiError(0, caught instanceof Error ? caught.message : String(caught));
      }
    }
  }

  if (!response.ok) {
    if (response.status === 401 && token !== null && token !== "") {
      expireAuthSession();
    }
    const errors = await parseErrorBody(response);
    const firstErr = errors[0];
    const rawDetail = firstErr?.["detail"];
    const rawTitle = firstErr?.["title"];
    const detail = isString(rawDetail) ? rawDetail : null;
    const title = isString(rawTitle) ? rawTitle : null;
    throw new ApiError(
      response.status,
      detail ?? title ?? `API request failed (${response.status})`,
      extractFieldErrors(errors),
    );
  }

  if (response.body === null) throw new Error("The explainer stream had no response body.");

  // Providers that ignore stream: true are folded into the SSE protocol
  // backend-side, so a JSON content-type here means the backend itself broke
  // its contract; surface it as an error event instead of hanging.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    // SAFETY: this branch is the backend's non-stream error path, which
    // returns a JSON:API error document; the explanation field is
    // typeof-checked below before it is surfaced.
    const parsed = (await response.json().catch((): null => null)) as {
      data?: { attributes?: { explanation?: string; model?: string; "reasoning-effort"?: string | null } };
    } | null;
    const attributes = parsed?.data?.attributes;
    if (attributes?.explanation !== undefined && attributes.explanation !== "") {
      const reasoningEffort = reasoningEffortValue(attributes["reasoning-effort"]);
      onEvent({ name: "meta", data: { kind, model: attributes.model ?? "", "reasoning-effort": reasoningEffort } });
      onEvent({ name: "content", data: { text: attributes.explanation } });
      onEvent({ name: "done", data: { model: attributes.model ?? "", "reasoning-effort": reasoningEffort, "generated-at": new Date().toISOString() } });
      return;
    }
    throw new Error("The explainer returned an unexpected response format.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        if (frame.trim() === "") continue;
        const event = parseExplainFrame(frame);
        if (event === null) continue;
        if (event.name === "done") {
          onEvent(event);
          completed = true;
          await reader.cancel().catch((): null => null);
          return;
        }
        if (event.name === "error") {
          throw new ApiError(0, event.data.message);
        }
        onEvent(event);
      }
    }
  } finally {
    // Cancel the underlying body on error and unexpected-end exits so the
    // connection is released; done-path cancellation is handled above.
    if (!completed) await reader.cancel().catch((): null => null);
    reader.releaseLock();
  }
  throw new ApiError(0, "The explainer stream ended without a done event.");
}

function parseExplainFrame(frame: string): ExplainStreamEvent | null {
  let name = "message";
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("event:")) {
      name = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  if (raw === "[DONE]") return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const object = asRecordOrNull(payload);
  if (object === null) return null;
  switch (name) {
    case "meta": {
      const model = isString(object["model"]) ? object["model"] : "";
      const reasoningEffort = reasoningEffortValue(object["reasoning-effort"]);
      const kindValue = object["kind"];
      const kind: ExplainKind = kindValue === "apply" ? "apply" : "plan";
      return { name: "meta", data: { kind, model, "reasoning-effort": reasoningEffort } };
    }
    case "thinking": {
      const text = isString(object["text"]) ? object["text"] : "";
      return text === "" ? null : { name: "thinking", data: { text } };
    }
    case "content": {
      const text = isString(object["text"]) ? object["text"] : "";
      return { name: "content", data: { text } };
    }
    case "content-reset": {
      const text = isString(object["text"]) ? object["text"] : "";
      return { name: "content-reset", data: { text } };
    }
    case "done": {
      const model = isString(object["model"]) ? object["model"] : "";
      const reasoningEffort = reasoningEffortValue(object["reasoning-effort"]);
      const generatedAt = isString(object["generated-at"]) ? object["generated-at"] : new Date().toISOString();
      const cached = object["cached"] === true;
      return { name: "done", data: { model, "reasoning-effort": reasoningEffort, "generated-at": generatedAt, cached } };
    }
    case "error": {
      const message = isString(object["message"]) && object["message"] !== "" ? object["message"] : "The explainer reported an unknown error";
      return { name: "error", data: { message } };
    }
    case "progress": {
      const status = isString(object["status"]) ? object["status"] : "";
      const jobId = isString(object["job-id"]) ? object["job-id"] : "";
      const runId = isString(object["runId"]) ? object["runId"] : "";
      const kind: ExplainKind = object["kind"] === "apply" ? "apply" : "plan";
      const createdAt = isString(object["created-at"]) ? object["created-at"] : "";
      const updatedAt = isString(object["updated-at"]) ? object["updated-at"] : "";
      return { name: "progress", data: { status, "job-id": jobId, runId, kind, "created-at": createdAt, "updated-at": updatedAt } };
    }
    default:
      return null;
  }
}

/** Resolve the bearer token, refreshing it first when it is about to expire. */
export async function prepareAuthToken(): Promise<string | null> {
  let token = getAuthToken();
  const expiresAt = getAuthTokenExpiry();
  if (
    token !== null
    && token !== ""
    && expiresAt !== null
    && expiresAt <= Date.now()
    && isRefreshableSession()
  ) {
    token = await refreshAccessToken().catch((): null => null) ?? token;
  }
  return token;
}

function removeAuthToken(): void {
  clearAuthMemory();
  storageRemove(SESSION_EXPIRED_KEY);
  window.dispatchEvent(new CustomEvent(AUTH_CHANGED_EVENT));
}

export async function logoutAuthSession(): Promise<void> {
  const refreshable = isRefreshableSession();
  try {
    if (refreshable) {
      await fetch(`${API_BASE_URL}/users/logout`, {
        method: "POST",
        credentials: "same-origin",
      });
    }
  } catch {
    // Local logout still succeeds when the server is unreachable.
  } finally {
    removeAuthToken();
  }
}