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
export function extractFieldErrors(rawErrors: readonly Record<string, unknown>[]): Record<string, string> {
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
