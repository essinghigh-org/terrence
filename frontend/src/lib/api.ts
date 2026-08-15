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
  readonly json: () => Promise<unknown>;
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
export function extractFieldErrors(rawErrors: readonly Readonly<Record<string, unknown>>[]) {
  const fieldErrors: Record<string, string> = {};
  for (const entry of rawErrors) {
    const source = entry["source"];
    const pointer = asRecordOrNull(source)?.["pointer"];
    if (typeof pointer !== "string" || pointer === "") continue;
    const detail = typeof entry["detail"] === "string" ? entry["detail"] : "";
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
  const normalizedExpiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : expiresAt;
  accessTokenExpiry = typeof normalizedExpiry === "number" && Number.isFinite(normalizedExpiry)
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

export async function readResponseBody(response: ReadonlyResponse): Promise<unknown> {
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
 * Sessions stored by pre-memory builds (legacy localStorage tokens) are
 * adopted exactly once and deleted, so no sensitive value persists after
 * this page load. Returns null when there is no session, which leaves the
 * app at the login screen.
 */
export async function bootstrapAuth(): Promise<string | null> {
  if (accessToken !== null) return accessToken;
  const legacy = adoptLegacyStoredToken();
  if (legacy !== null) return legacy;
  return refreshAccessToken(true).catch((): null => null);
}

/** Read a pre-memory-build token from localStorage once, then delete it. */
function adoptLegacyStoredToken(): string | null {
  let legacyToken: string | null = null;
  let legacyExpiry: string | null = null;
  let legacyRefreshable = false;
  try {
    legacyToken = storageGet("tfe_token");
    legacyExpiry = storageGet("tfe_token_expires_at");
    legacyRefreshable = storageGet("tfe_refreshable_session") === "true";
  } catch {
    return null;
  }
  if (legacyToken === null || legacyToken === "") return null;
  try {
    storageRemove("tfe_token");
    storageRemove("tfe_token_expires_at");
    storageRemove("tfe_refreshable_session");
  } catch {
    // The token was already read; the session still works for this page load.
  }
  const expiry = legacyExpiry === null ? null : Number(legacyExpiry);
  // An expired non-refreshable legacy token is dead: adopting it would
  // immediately fail every request. Expired refreshable sessions are still
  // adopted so the refresh path can rotate through the cookie.
  if (Number.isFinite(expiry) && expiry !== null && expiry <= Date.now() && !legacyRefreshable) {
    storageSet(SESSION_EXPIRED_KEY, "true");
    return null;
  }
  setAuthToken(legacyToken, Number.isFinite(expiry) ? expiry : null, legacyRefreshable);
  return legacyToken;
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
    if (typeof token !== "string" || token === "") return null;
    setAuthToken(
      token,
      typeof expiresAt === "string" || typeof expiresAt === "number" ? expiresAt : null,
      true,
    );
    return token;
  })().finally((): void => {
    refreshRequest = null;
  });
  return refreshRequest;
}

export async function fetchApi(endpoint: string, options: ReadonlyRequestInit = {}): Promise<unknown> {
  // Absolute /api/* paths (v1 compatibility endpoints like /api/v1/metadata)
  // are used verbatim; everything else is relative to the v2 API base.
  const url = endpoint.startsWith("/api/")
    ? endpoint
    : `${API_BASE_URL}${endpoint}`;
  const send = async (accessToken: string | null): Promise<Response> => {
    // SAFETY: Headers accepts record and tuple-array shapes; the readonly
    // modifiers on the stored options are compile-time only.
    const headers = new Headers(options.headers as HeadersInit | undefined);
    if (!headers.has("Content-Type") && (options.body === undefined || options.body === null || typeof options.body === "string")) {
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

  if (!response.ok) {
    if (response.status === 401 && token !== null && token !== "" && !url.endsWith("/users/login")) {
      expireAuthSession();
    }
    const errors = await parseErrorBody(response);
    const firstErr = errors[0];
    const detail = typeof firstErr?.["detail"] === "string" ? firstErr["detail"] : null;
    const title = typeof firstErr?.["title"] === "string" ? firstErr["title"] : null;
    throw new ApiError(
      response.status,
      detail ?? title ?? `API request failed (${response.status})`,
      extractFieldErrors(errors),
    );
  }

  return readResponseBody(response);
}

export async function fetchAllApiPages<T>(endpoint: string, signal?: Readonly<AbortSignal>): Promise<T[]> {
  const data: T[] = [];
  const visited = new Set<string>();
  let pageEndpoint: string | null = endpoint;

  while (pageEndpoint !== null && !visited.has(pageEndpoint)) {
    visited.add(pageEndpoint);
    // SAFETY: list endpoints return the JSON:API collection envelope; the
    // data array and pagination meta fields are checked below.
    const response = await fetchApi(
      pageEndpoint,
      signal === undefined ? {} : { signal },
    ) as {
      data?: T[];
      meta?: { pagination?: Record<string, unknown> };
    };
    if (Array.isArray(response.data)) data.push(...response.data);

    const nextPage = response.meta?.pagination?.["next-page"];
    if (typeof nextPage !== "number" || !Number.isSafeInteger(nextPage) || nextPage < 1) {
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
function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  // SAFETY: the typeof-object guard is the boundary check; callers validate
  // individual fields with typeof before use.
  return value as Record<string, unknown>;
}

/** Narrow a backend reasoning-effort value to the known union, or null. */
function reasoningEffortValue(value: unknown): ReasoningEffort | null {
  // SAFETY: the set membership check is the boundary validation; unknown
  // backend values degrade to null so the UI renders the default effort.
  return typeof value === "string" && REASONING_EFFORT_SET.has(value) ? value as ReasoningEffort : null;
}

/** Parse a JSON:API error document from a failed response, or [] when it is not JSON. */
async function parseErrorBody(response: Response): Promise<readonly Record<string, unknown>[]> {
  const errorBody = asRecordOrNull(await response.json().catch((): null => null));
  const rawErrors = errorBody !== null ? errorBody["errors"] : undefined;
  // SAFETY: Array.isArray is the boundary check; entries are only read via
  // typeof-validated string fields in extractFieldErrors below.
  return Array.isArray(rawErrors) ? rawErrors as Record<string, unknown>[] : [];
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
>;

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
    const detail = typeof firstErr?.["detail"] === "string" ? firstErr["detail"] : null;
    const title = typeof firstErr?.["title"] === "string" ? firstErr["title"] : null;
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
      const model = typeof object["model"] === "string" ? object["model"] : "";
      const reasoningEffort = reasoningEffortValue(object["reasoning-effort"]);
      const kindValue = object["kind"];
      const kind: ExplainKind = kindValue === "apply" ? "apply" : "plan";
      return { name: "meta", data: { kind, model, "reasoning-effort": reasoningEffort } };
    }
    case "thinking": {
      const text = typeof object["text"] === "string" ? object["text"] : "";
      return text === "" ? null : { name: "thinking", data: { text } };
    }
    case "content": {
      const text = typeof object["text"] === "string" ? object["text"] : "";
      return { name: "content", data: { text } };
    }
    case "content-reset": {
      const text = typeof object["text"] === "string" ? object["text"] : "";
      return { name: "content-reset", data: { text } };
    }
    case "done": {
      const model = typeof object["model"] === "string" ? object["model"] : "";
      const reasoningEffort = reasoningEffortValue(object["reasoning-effort"]);
      const generatedAt = typeof object["generated-at"] === "string" ? object["generated-at"] : new Date().toISOString();
      const cached = object["cached"] === true;
      return { name: "done", data: { model, "reasoning-effort": reasoningEffort, "generated-at": generatedAt, cached } };
    }
    case "error": {
      const message = typeof object["message"] === "string" && object["message"] !== "" ? object["message"] : "The explainer reported an unknown error";
      return { name: "error", data: { message } };
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
