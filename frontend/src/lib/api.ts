import { isNumber, isRecord, isString } from "../lib/type-guards";
import type { JsonObject, JsonValue } from "@/lib/json";
import { clearActiveUserIdentity } from "./storage-identity";
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

  /** Stable server/client error identifier for support and automation. */
  public readonly code: string;

  /** Correlation identifier returned by the API, when available. */
  public readonly requestId: string | null;

  /** Field-level 422 details, keyed as `{ "data.attributes.<field>": msg }`. */
  public readonly fieldErrors: Readonly<Record<string, string>>;

  public constructor(
    status: number,
    message: string,
    fieldErrors: Readonly<Record<string, string>> = {},
    public readonly retryAfter: string | null = null,
    code = `HTTP_${status}`,
    requestId: string | null = null,
    public readonly idempotencyReplayed = false,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fieldErrors = fieldErrors;
    this.code = code.trim() === "" ? `HTTP_${status}` : code;
    this.requestId = requestId === null || requestId.trim() === "" ? null : requestId;
  }
}

/** The server asks clients to retry these responses only for read traversals or
 * when the caller supplied an Idempotency-Key for a write. */
export function isRetryableApiError(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 429 || error.status === 503);
}

/** Convert a Retry-After header to a bounded delay, preserving HTTP-date support. */
export function retryAfterDelayMilliseconds(value: string | null, now = Date.now()): number | null {
  if (value === null) return 1_000;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : null;
}

/**
 * Extract field-level error details from a JSON:API error document. An
 * error entry with `source.pointer` (e.g. "/data/attributes/name") is
 * surfaced so UIs can render per-field feedback instead of a single blob
 * (26.9). Unparsable pointers are dropped.
 */
export function extractFieldErrors(rawErrors: readonly Readonly<JsonObject>[]): Record<string, string> {
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

async function sendApiRequest(url: string, options: ReadonlyRequestInit = {}, token: string | null = null): Promise<Response> {
  // SAFETY: Headers accepts record and tuple-array shapes; the readonly
  // modifiers on the stored options are compile-time only.
  const headers = new Headers(options.headers as HeadersInit | undefined);
  if (!headers.has("Content-Type") && (options.body === undefined || options.body === null || isString(options.body))) {
    headers.set("Content-Type", "application/vnd.api+json");
  }
  if (token !== null && token !== "") {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(url, {
    // SAFETY: ReadonlyRequestInit is RequestInit with readonly modifiers;
    // spreading it is shape-identical at runtime.
    ...(options as RequestInit),
    headers,
  });
}

function hasUsableToken(token: string | null): boolean {
  return token !== null && token !== "";
}

function shouldRefreshBeforeRequest(token: string | null, expiresAt: number | null): boolean {
  return hasUsableToken(token) && expiresAt !== null && expiresAt <= Date.now() && isRefreshableSession();
}

function isAuthEndpoint(url: string): boolean {
  return url.endsWith("/users/login") || url.endsWith("/users/refresh") || url.endsWith("/users/logout");
}

function shouldRetryWorkspace404(status: number, method: string | undefined, token: string | null, url: string): boolean {
  // A stale in-memory token can yield 404 on workspace-scoped reads
  // when the principal lacks that workspace. Har review showed 5 rapid
  // 404s for /workspaces/ws-…/runs with Bearer VvQ… while the same URL
  // succeeded with HrTW… after a refresh. Retry a single 404 via the
  // refresh cookie when in a refreshable session so the correct principal
  // is picked up without surfacing "Run history may be out of date".
  return status === 404
    && ["GET", "HEAD"].includes((method ?? "GET").toUpperCase())
    && hasUsableToken(token)
    && isRefreshableSession()
    && /\/api\/v2\/workspaces\/[^/]+\/(runs|state-versions|vars|varsets|resources|dependency-graph|current-state-version-outputs|readme)$/.test(url.split("?")[0] ?? url)
    && !isAuthEndpoint(url);
}

async function throwApiError(response: ReadonlyResponse, token: string | null, url: string): Promise<never> {
  if (response.status === 401 && token !== null && token !== "" && !url.endsWith("/users/login")) {
    expireAuthSession();
  }
  const errors = await parseErrorBody(response);
  const firstErr = errors[0];
  const rawDetail = firstErr?.["detail"];
  const rawTitle = firstErr?.["title"];
  const detail = isString(rawDetail) ? rawDetail : null;
  const title = isString(rawTitle) ? rawTitle : null;
  const rawCode = firstErr?.["code"];
  const code = isString(rawCode) && rawCode.trim() !== "" ? rawCode.trim() : `HTTP_${response.status}`;
  const requestId = response.headers.get("X-Request-Id")
    ?? response.headers.get("X-Correlation-Id");
  throw new ApiError(
    response.status,
    detail ?? title ?? `API request failed (${response.status})`,
    extractFieldErrors(errors),
    response.headers.get("Retry-After"),
    code,
    requestId,
    response.headers.get("Idempotency-Replayed") === "true",
  );
}

async function requestApi(endpoint: string, options: ReadonlyRequestInit = {}): Promise<Response> {
  // Absolute /api/* paths (v1 compatibility endpoints like /api/v1/metadata)
  // are used verbatim; everything else is relative to the v2 API base.
  const url = endpoint.startsWith("/api/")
    ? endpoint
    : `${API_BASE_URL}${endpoint}`;
  let token = getAuthToken();
  const expiresAt = getAuthTokenExpiry();
  if (shouldRefreshBeforeRequest(token, expiresAt)) {
    token = await refreshAccessToken().catch((): null => null) ?? token;
  }
  let response = await sendApiRequest(url, options, token);
  if (response.status === 401 && hasUsableToken(token) && isRefreshableSession() && !isAuthEndpoint(url)) {
    const refreshedToken = await refreshAccessToken().catch((): null => null);
    if (refreshedToken !== null) {
      response = await sendApiRequest(url, options, refreshedToken);
    }
  }
  if (shouldRetryWorkspace404(response.status, options.method, token, url)) {
    const refreshedToken = await refreshAccessToken().catch((): null => null);
    if (refreshedToken !== null && refreshedToken !== token) {
      response = await sendApiRequest(url, options, refreshedToken);
    }
  }

  if (!response.ok) {
    return throwApiError(response, token, url);
  }

  return response;
}

export async function fetchApi<T = unknown>(endpoint: string, options: ReadonlyRequestInit = {}): Promise<T> {
  // SAFETY: callers declare the expected response contract and validate its fields.
  return readResponseBody(await requestApi(endpoint, options)) as Promise<T>;
}

/** Preserve download bytes; parsing JSON can round numbers and changes its checksum. */
export async function fetchApiBlob(endpoint: string, options: ReadonlyRequestInit = {}): Promise<Blob> {
  return (await requestApi(endpoint, options)).blob();
}

export const MAX_PAGINATED_PAGES = 100;
export const MAX_PAGINATED_RECORDS = 10_000;

type PagedCollection<T> = {
  data?: T[];
  meta?: { pagination?: JsonObject };
};

function checkPaginationBudget(maxPages: number, maxRecords: number, retryAttempts: number): void {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGINATED_PAGES
    || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_PAGINATED_RECORDS
    || !Number.isSafeInteger(retryAttempts) || retryAttempts < 0 || retryAttempts > 3) {
    throw new Error("Invalid pagination budget.");
  }
}

async function sleepWithAbort(delay: number, signal: Readonly<AbortSignal> | undefined): Promise<void> {
  await new Promise<void>((resolve, reject): void => {
    const abort = (): void => { clearTimeout(timer); reject(new DOMException("Export cancelled", "AbortError")); };
    const timer = setTimeout((): void => { signal?.removeEventListener("abort", abort); resolve(); }, delay);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function fetchPageWithRetry<T>(pageEndpoint: string, signal: Readonly<AbortSignal> | undefined, retryAttempts: number): Promise<PagedCollection<T>> {
  let retries = 0;
  for (;;) {
    try {
      return await fetchApi(pageEndpoint, { method: "GET", ...(signal === undefined ? {} : { signal }) });
    } catch (error: unknown) {
      if (!isRetryableApiError(error) || retries++ >= retryAttempts) throw error;
      const delay = retryAfterDelayMilliseconds(error.retryAfter);
      // Long maintenance windows need a later user retry, not an export held in memory.
      if (delay === null || !Number.isFinite(delay) || delay > 30_000) throw error;
      signal?.throwIfAborted();
      await sleepWithAbort(delay, signal);
      signal?.throwIfAborted();
    }
  }
}

function nextPageEndpoint(pageEndpoint: string, nextPage: unknown): string | null {
  if (nextPage === undefined || nextPage === null) return null;
  if (!isNumber(nextPage) || !Number.isSafeInteger(nextPage) || nextPage < 1) throw new Error("The server returned invalid pagination metadata.");
  const nextUrl: URL = new globalThis.URL(pageEndpoint, "http://terrence.local");
  nextUrl.searchParams.set("page[number]", String(nextPage));
  return `${nextUrl.pathname}${nextUrl.search}`;
}

function assertPageNotRepeated(alreadyVisited: boolean, visitedCount: number, maxPages: number): void {
  if (alreadyVisited) throw new Error("The server repeated a page; the result is incomplete.");
  if (visitedCount >= maxPages) throw new Error(`The result exceeds ${maxPages} pages. Narrow the query and try again.`);
}

/** Explicit traversal only: ordinary list views should request a single page. */
export async function fetchAllApiPages<T>(
  endpoint: string,
  signal?: Readonly<AbortSignal>,
  options: Readonly<{
    maxPages?: number;
    maxRecords?: number;
    /** Override transient 429/503 retries for views with an explicit Retry action. */
    retryAttempts?: number;
    onProgress?: (records: number) => void;
  }> = {},
): Promise<T[]> {
  const maxPages = options.maxPages ?? MAX_PAGINATED_PAGES;
  const maxRecords = options.maxRecords ?? MAX_PAGINATED_RECORDS;
  const retryAttempts = options.retryAttempts ?? 3;
  checkPaginationBudget(maxPages, maxRecords, retryAttempts);
  const data: T[] = [];
  const visited = new Set<string>();
  let pageEndpoint = endpoint;
  for (;;) {
    signal?.throwIfAborted();
    assertPageNotRepeated(visited.has(pageEndpoint), visited.size, maxPages);
    visited.add(pageEndpoint);
    const response = await fetchPageWithRetry<T>(pageEndpoint, signal, retryAttempts);
    signal?.throwIfAborted();
    if (!Array.isArray(response.data)) throw new Error("The server returned an invalid collection.");
    if (data.length + response.data.length > maxRecords) throw new Error(`The result exceeds ${maxRecords} records. Narrow the query and try again.`);
    data.push(...response.data);
    options.onProgress?.(data.length);
    const next = nextPageEndpoint(pageEndpoint, response.meta?.pagination?.["next-page"]);
    if (next === null) break;
    pageEndpoint = next;
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
async function parseErrorBody(response: ReadonlyResponse): Promise<readonly JsonObject[]> {
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
  if (data === undefined) return null;
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
  const resp = await fetchApi<{ data?: { attributes?: Record<string, unknown> } }>(
    `/runs/${encodeURIComponent(runId)}/explain`,
    { method: "POST", body: JSON.stringify({ data: { type: "plan-explanations", attributes: { kind } } }) },
  );
  const attrs = resp.data?.attributes;
  if (attrs !== undefined && typeof attrs["status"] === "string") return { status: attrs["status"], jobId: typeof attrs["job-id"] === "string" ? attrs["job-id"] : undefined };
  if (attrs !== undefined && typeof attrs["explanation"] === "string") return { status: "succeeded" };
  return { status: "queued" };
}

async function sendExplainRequest(
  url: string,
  kind: ExplainKind,
  refresh: boolean,
  signal: Readonly<AbortSignal> | undefined,
  accessToken: string | null,
): Promise<Response> {
  const headers: HeadersInit = {
    "Content-Type": "application/vnd.api+json",
    // NOTE: spelled with concatenation so the "`Bearer " sequence never
    // appears; secret-redaction tooling mangles that template spelling.
    ...(accessToken !== null ? { Authorization: "Bearer " + accessToken } : undefined),
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
}

/** Null when the request was aborted; callers resolve void in that case. */
async function trySendExplainRequest(
  url: string,
  kind: ExplainKind,
  refresh: boolean,
  signal: Readonly<AbortSignal> | undefined,
  token: string | null,
): Promise<Response | null> {
  try {
    return await sendExplainRequest(url, kind, refresh, signal, token);
  } catch (caught: unknown) {
    if (signal?.aborted === true) return null;
    throw new ApiError(0, caught instanceof Error ? caught.message : String(caught));
  }
}

async function throwExplainHttpError(response: ReadonlyResponse, token: string | null): Promise<void> {
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
    response.headers.get("Retry-After"),
    undefined,
    response.headers.get("X-Request-Id") ?? response.headers.get("X-Correlation-Id"),
    response.headers.get("Idempotency-Replayed") === "true",
  );
}

/**
 * Providers that ignore stream: true are folded into the SSE protocol
 * backend-side, so a JSON content-type here means the backend itself broke
 * its contract; surface it as an error event instead of hanging.
 */
async function replayCachedExplanation(
  response: ReadonlyResponse,
  kind: ExplainKind,
  onEvent: (event: Readonly<ExplainStreamEvent>) => void,
): Promise<boolean> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) return false;
  // SAFETY: this branch is the backend's non-stream error path, which
  // returns a JSON:API error document; the explanation field is
  // typeof-checked below before it is surfaced.
  const parsed = (await response.json().catch((): null => null)) as {
    data?: { attributes?: { explanation?: string; model?: string; "reasoning-effort"?: string | null } };
  } | null;
  const attributes = parsed?.data?.attributes;
  if (attributes?.explanation === undefined || attributes.explanation === "") {
    throw new Error("The explainer returned an unexpected response format.");
  }
  const reasoningEffort = reasoningEffortValue(attributes["reasoning-effort"]);
  onEvent({ name: "meta", data: { kind, model: attributes.model ?? "", "reasoning-effort": reasoningEffort } });
  onEvent({ name: "content", data: { text: attributes.explanation } });
  onEvent({ name: "done", data: { model: attributes.model ?? "", "reasoning-effort": reasoningEffort, "generated-at": new Date().toISOString() } });
  return true;
}

/** Minimal body-reader surface for the SSE frame pump (readonly-param discipline). */
type FrameStreamReader = Readonly<{
  readonly read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  readonly cancel: () => Promise<void>;
  readonly releaseLock: () => void;
}>;

async function pumpExplainFrames(
  reader: FrameStreamReader,
  onEvent: (event: Readonly<ExplainStreamEvent>) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
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
        await reader.cancel().catch((): null => null);
        return;
      }
      if (event.name === "error") {
        throw new ApiError(0, event.data.message);
      }
      onEvent(event);
    }
  }
  throw new ApiError(0, "The explainer stream ended without a done event.");
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
  let token = await prepareAuthToken();
  const first = await trySendExplainRequest(url, kind, refresh, signal, token);
  if (first === null) return;
  let response = first;
  if (response.status === 401 && token !== null && token !== "" && isRefreshableSession()) {
    const refreshedToken = await refreshAccessToken().catch((): null => null);
    if (refreshedToken !== null) {
      token = refreshedToken;
      const retry = await trySendExplainRequest(url, kind, refresh, signal, refreshedToken);
      if (retry === null) return;
      response = retry;
    }
  }

  if (!response.ok) {
    await throwExplainHttpError(response, token);
  }

  if (response.body === null) throw new Error("The explainer stream had no response body.");

  if (await replayCachedExplanation(response, kind, onEvent)) return;

  const reader = response.body.getReader();
  let completed = false;
  try {
    await pumpExplainFrames(reader, onEvent);
    completed = true;
  } finally {
    // Cancel the underlying body on error and unexpected-end exits so the
    // connection is released; done-path cancellation is handled above.
    if (!completed) await reader.cancel().catch((): null => null);
    reader.releaseLock();
  }
}

function splitExplainFrame(frame: string): { name: string; raw: string | null } {
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
  if (dataLines.length === 0) return { name, raw: null };
  const raw = dataLines.join("\n");
  if (raw === "[DONE]") return { name, raw: null };
  return { name, raw };
}

/** Unknown-valued SSE payload fields; event builders validate each field. */
type ExplainPayloadFields = Readonly<Record<string, unknown>>;

function explainTextEvent(
  name: "thinking" | "content" | "content-reset",
  object: ExplainPayloadFields,
): ExplainStreamEvent | null {
  const text = isString(object["text"]) ? object["text"] : "";
  if (name === "thinking") return text === "" ? null : { name, data: { text } };
  return { name, data: { text } };
}

function explainMetaEvent(object: ExplainPayloadFields): ExplainStreamEvent {
  const model = isString(object["model"]) ? object["model"] : "";
  const reasoningEffort = reasoningEffortValue(object["reasoning-effort"]);
  const kind: ExplainKind = object["kind"] === "apply" ? "apply" : "plan";
  return { name: "meta", data: { kind, model, "reasoning-effort": reasoningEffort } };
}

function explainDoneEvent(object: ExplainPayloadFields): ExplainStreamEvent {
  const model = isString(object["model"]) ? object["model"] : "";
  const reasoningEffort = reasoningEffortValue(object["reasoning-effort"]);
  const generatedAt = isString(object["generated-at"]) ? object["generated-at"] : new Date().toISOString();
  const cached = object["cached"] === true;
  return { name: "done", data: { model, "reasoning-effort": reasoningEffort, "generated-at": generatedAt, cached } };
}

function explainErrorEvent(object: ExplainPayloadFields): ExplainStreamEvent {
  const message = isString(object["message"]) && object["message"] !== "" ? object["message"] : "The explainer reported an unknown error";
  return { name: "error", data: { message } };
}

function explainProgressEvent(object: ExplainPayloadFields): ExplainStreamEvent {
  const status = isString(object["status"]) ? object["status"] : "";
  const jobId = isString(object["job-id"]) ? object["job-id"] : "";
  const runId = isString(object["runId"]) ? object["runId"] : "";
  const kind: ExplainKind = object["kind"] === "apply" ? "apply" : "plan";
  const createdAt = isString(object["created-at"]) ? object["created-at"] : "";
  const updatedAt = isString(object["updated-at"]) ? object["updated-at"] : "";
  return { name: "progress", data: { status, "job-id": jobId, runId, kind, "created-at": createdAt, "updated-at": updatedAt } };
}

function parseExplainFrame(frame: string): ExplainStreamEvent | null {
  const { name, raw } = splitExplainFrame(frame);
  if (raw === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const object = asRecordOrNull(payload);
  if (object === null) return null;
  switch (name) {
    case "meta":
      return explainMetaEvent(object);
    case "thinking":
      return explainTextEvent("thinking", object);
    case "content":
      return explainTextEvent("content", object);
    case "content-reset":
      return explainTextEvent("content-reset", object);
    case "done":
      return explainDoneEvent(object);
    case "error":
      return explainErrorEvent(object);
    case "progress":
      return explainProgressEvent(object);
    default:
      return null;
  }
}

export type RunLogTail = Readonly<{
  /** Bytes appended since `offset`, decoded as UTF-8. */
  chunk: string;
  /** Total size of the whole phase log, in bytes. */
  totalBytes: number;
  /**
   * False when the server did not report a total (a proxy stripping `X-*`
   * headers), so `totalBytes` is a floor rather than a fact. Callers must not
   * conclude "the stream shrank" from an unknown total.
   */
  totalKnown: boolean;
  /** Byte offset immediately after `chunk` — pass it as the next `offset`. */
  nextOffset: number;
  /** True when the stream no longer covers every row ever written. */
  truncated: boolean;
}>;

async function maybeRefreshLogResponse(
  send: (token: string | null) => Promise<Response>,
  token: string | null,
  status: number,
): Promise<Response | null> {
  // `prepareAuthToken` only refreshes when the local clock already says the
  // token expired. Without this retry a token revoked or expired server-side
  // froze both log panes silently and permanently, while the rest of the page
  // (which goes through fetchApi, and does retry) carried on working.
  if (status !== 401 || !hasUsableToken(token) || !isRefreshableSession()) return null;
  const refreshed = await refreshAccessToken().catch((): null => null);
  if (refreshed === null) {
    expireAuthSession();
    return null;
  }
  const response = await send(refreshed);
  if (response.status === 401) expireAuthSession();
  return response;
}

/**
 * Read a phase log forward from a byte offset.
 *
 * The paged `/runs/:id/logs` JSON:API collection returns page 1 of 20 rows by
 * default, so a view that re-read it on a timer showed the *first* twenty rows
 * of a growing log forever — the window looked frozen while the run streamed.
 * The raw log endpoints speak the TFE log-read protocol instead
 * (`?offset=&limit=` over the joined byte stream, with the true total in
 * `X-Terrence-Log-Total-Bytes`), which makes a tail append-only by
 * construction: a late response can only ever carry bytes the caller does not
 * have yet, so log text can never move backwards.
 *
 * `offset` past the end returns an empty chunk, which is the idle case while a
 * phase is running but quiet.
 *
 * DELIBERATELY sends no `limit`. The server documents that a windowed read is
 * byte-exact and may therefore split a multibyte character, whereas an
 * unlimited read always ends at end-of-stream and so is always complete, valid
 * UTF-8. That is what makes the `text()` → byte-length round-trip below exact.
 * Adding a `limit` here without switching to an incremental streaming decoder
 * would let a split codepoint decode to U+FFFD, re-encode to three bytes, and
 * put `nextOffset` permanently out of step with the server.
 */
export async function fetchRunLogTail(
  runId: string,
  phase: "plan" | "apply",
  offset: number,
  signal?: Readonly<AbortSignal>,
): Promise<RunLogTail> {
  const from = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
  const path = `${API_BASE_URL}/runs/${encodeURIComponent(runId)}/${phase}/log?offset=${from}`;
  const send = async (accessToken: string | null): Promise<Response> => {
    const headers = new Headers();
    if (accessToken !== null && accessToken !== "") {
      headers.set("Authorization", `Bearer ${accessToken}`);
    }
    return fetch(path, { headers, ...(signal === undefined ? {} : { signal }) });
  };

  const token = await prepareAuthToken();
  const first = await send(token);
  const response = await maybeRefreshLogResponse(send, token, first.status) ?? first;

  if (!response.ok) {
    throw new ApiError(response.status, `Could not read the ${phase} log (${response.status})`);
  }
  // The raw log endpoints answer in text/plain. Anything else is a misrouted
  // response — a JSON:API error envelope from a proxy, say — and rendering its
  // body into the log pane as if it were Terraform output would be worse than
  // showing nothing.
  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType !== "" && !contentType.startsWith("text/")) {
    return { chunk: "", totalBytes: from, totalKnown: false, nextOffset: from, truncated: false };
  }
  const chunk = await response.text();
  // The byte length of the chunk, not its character length: a multibyte
  // character makes the two disagree, and the next offset must be in bytes.
  const chunkBytes = new TextEncoder().encode(chunk).byteLength;
  const headerTotal = Number.parseInt(response.headers.get("X-Terrence-Log-Total-Bytes") ?? "", 10);
  const knownTotal = Number.isSafeInteger(headerTotal) && headerTotal >= 0;
  return {
    chunk,
    // Falling back to `from + chunkBytes` when the header is missing is not
    // merely approximate: it is always >= the requested offset, which makes
    // the caller's "the stream shrank, restart it" branch unreachable. Say so
    // via `totalKnown` rather than quietly reporting a total we do not have.
    totalBytes: knownTotal ? headerTotal : from + chunkBytes,
    totalKnown: knownTotal,
    nextOffset: from + chunkBytes,
    truncated: response.headers.get("X-Terrence-Log-Truncated") === "true",
  };
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
  clearActiveUserIdentity();
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
