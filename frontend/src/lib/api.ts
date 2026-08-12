const API_BASE_URL = "/api/v2";
export const AUTH_CHANGED_EVENT = "terrence:auth-changed";
export const AUTH_EXPIRED_EVENT = "terrence:auth-expired";

const TOKEN_KEY = "tfe_token";
const TOKEN_EXPIRY_KEY = "tfe_token_expires_at";
const REFRESHABLE_KEY = "tfe_refreshable_session";
const SESSION_EXPIRED_KEY = "tfe_session_expired";

type ReadonlyResponse = Readonly<{
  readonly status: number;
  readonly headers: Readonly<Headers>;
  readonly json: () => Promise<unknown>;
  readonly text: () => Promise<string>;
}>;

type ReadonlyRequestInit = Readonly<{
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>> | readonly (readonly [string, string])[];
  readonly body?: string | null;

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
export function extractFieldErrors(rawErrors: readonly Readonly<Record<string, unknown>>[]): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const entry of rawErrors) {
    const source = entry["source"];
    const pointer = source !== null && typeof source === "object"
      ? (source as Record<string, unknown>)["pointer"]
      : undefined;
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
  const token = localStorage.getItem(TOKEN_KEY);
  if (token === null) return null;
  const expiresAt = getAuthTokenExpiry();
  if (expiresAt !== null && expiresAt <= Date.now() && !isRefreshableSession()) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXPIRY_KEY);
    localStorage.setItem(SESSION_EXPIRED_KEY, "true");
    return null;
  }
  return token;
}

export function getAuthTokenExpiry(): number | null {
  const value = localStorage.getItem(TOKEN_EXPIRY_KEY);
  if (value === null) return null;
  const expiresAt = Number(value);
  return Number.isFinite(expiresAt) ? expiresAt : null;
}

export function isRefreshableSession(): boolean {
  return localStorage.getItem(REFRESHABLE_KEY) === "true";
}

export function setAuthToken(
  token: string,
  expiresAt?: string | number | null,
  refreshable = false,
): void {
  localStorage.setItem(TOKEN_KEY, token);
  const normalizedExpiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : expiresAt;
  if (typeof normalizedExpiry === "number" && Number.isFinite(normalizedExpiry)) {
    localStorage.setItem(TOKEN_EXPIRY_KEY, String(normalizedExpiry));
  } else {
    localStorage.removeItem(TOKEN_EXPIRY_KEY);
  }
  if (refreshable) {
    localStorage.setItem(REFRESHABLE_KEY, "true");
  } else {
    localStorage.removeItem(REFRESHABLE_KEY);
  }
  localStorage.removeItem(SESSION_EXPIRED_KEY);
  window.dispatchEvent(new CustomEvent(AUTH_CHANGED_EVENT));
}

export function expireAuthSession(): void {
  const alreadyExpired = localStorage.getItem(SESSION_EXPIRED_KEY) === "true";
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);
  localStorage.removeItem(REFRESHABLE_KEY);
  localStorage.setItem(SESSION_EXPIRED_KEY, "true");
  if (!alreadyExpired) window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
}

export function consumeAuthExpiry(): boolean {
  const expired = localStorage.getItem(SESSION_EXPIRED_KEY) === "true";
  localStorage.removeItem(SESSION_EXPIRED_KEY);
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

async function refreshAccessToken(): Promise<string | null> {
  if (!isRefreshableSession()) return null;
  refreshRequest ??= (async (): Promise<string | null> => {
    const response = await fetch(`${API_BASE_URL}/users/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      credentials: "same-origin",
    });
    if (!response.ok) return null;
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
  const url = endpoint === API_BASE_URL || endpoint.startsWith(`${API_BASE_URL}/`)
    ? endpoint
    : `${API_BASE_URL}${endpoint}`;
  const send = async (accessToken: string | null): Promise<Response> => {
    const headers = new Headers(options.headers as HeadersInit | undefined);
    headers.set("Content-Type", "application/vnd.api+json");
    if (accessToken !== null && accessToken !== "") {
      headers.set("Authorization", `Bearer ${accessToken}`);
    }
    return fetch(url, {
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
    const errorBody = (await response.json().catch((): null => null)) as Record<string, unknown> | null;
    const rawErrors = errorBody !== null ? errorBody["errors"] : undefined;
    const errors = Array.isArray(rawErrors) ? (rawErrors as Record<string, unknown>[]) : [];
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

/**
 * SSE event emitted by the streaming run-explain endpoint. The backend relays
 * upstream deltas as `meta`, `thinking`, `content`, `done`, and `error`
 * events; cached generations are replayed under the same envelope (done
 * carries `cached: true`). All payloads are JSON.
 */
export type ExplainStreamEvent = Readonly<
  | { name: "meta"; data: Readonly<{ kind: ExplainKind; model: string }> }
  | { name: "thinking"; data: Readonly<{ text: string }> }
  | { name: "content"; data: Readonly<{ text: string }> }
  | { name: "content-reset"; data: Readonly<{ text: string }> }
  | { name: "done"; data: Readonly<{ model: string; "generated-at": string; cached?: boolean }> }
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
      ...(accessToken !== null ? { Authorization: `Bearer ${accessToken}` } : {}),
    };
    return fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        data: {
          type: "plan-explanations",
          attributes: { kind, stream: true, ...(refresh ? { refresh: true } : {}) },
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
    const errorBody = (await response.json().catch((): null => null)) as Record<string, unknown> | null;
    const rawErrors = errorBody !== null ? errorBody["errors"] : undefined;
    const errors = Array.isArray(rawErrors) ? (rawErrors as Record<string, unknown>[]) : [];
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
    const parsed = (await response.json().catch((): null => null)) as {
      data?: { attributes?: { explanation?: string; model?: string } };
    } | null;
    const attributes = parsed?.data?.attributes;
    if (attributes?.explanation !== undefined && attributes.explanation !== "") {
      onEvent({ name: "content", data: { text: attributes.explanation } });
      onEvent({ name: "done", data: { model: attributes.model ?? "", "generated-at": new Date().toISOString() } });
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
  const object = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (object === null) return null;
  switch (name) {
    case "meta": {
      const model = typeof object["model"] === "string" ? object["model"] : "";
      const kindValue = object["kind"];
      const kind: ExplainKind = kindValue === "apply" ? "apply" : "plan";
      return { name: "meta", data: { kind, model } };
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
      const generatedAt = typeof object["generated-at"] === "string" ? object["generated-at"] : new Date().toISOString();
      const cached = object["cached"] === true;
      return { name: "done", data: { model, "generated-at": generatedAt, cached } };
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
async function prepareAuthToken(): Promise<string | null> {
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
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);
  localStorage.removeItem(REFRESHABLE_KEY);
  localStorage.removeItem(SESSION_EXPIRED_KEY);
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
