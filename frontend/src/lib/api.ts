export const API_BASE_URL = "/api/v2";

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
}>;


export function getAuthToken(): string | null {
  return localStorage.getItem("tfe_token");
}

export function setAuthToken(token: string): void {
  localStorage.setItem("tfe_token", token);
}

export async function readResponseBody(response: ReadonlyResponse): Promise<unknown> {
  if (response.status === 204) return null;
  const contentType = response.headers.get("Content-Type");
  if (contentType?.includes("json") === true) {
    return await response.json();
  }
  return await response.text();
}

export async function fetchApi(endpoint: string, options: ReadonlyRequestInit = {}): Promise<unknown> {
  const token = getAuthToken();
  const headers = new Headers(options.headers as HeadersInit | undefined);
  headers.set("Content-Type", "application/vnd.api+json");
  if (token !== null && token !== "") {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...(options as RequestInit),
    headers,
  });

  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem("tfe_token");
      window.location.href = "/login";
    }
    const errorBody = (await response.json().catch((): null => null)) as Record<string, unknown> | null;
    const rawErrors = errorBody !== null ? errorBody["errors"] : undefined;
    const errors = Array.isArray(rawErrors) ? (rawErrors as Record<string, unknown>[]) : [];
    const firstErr = errors[0];
    const detail = typeof firstErr?.["detail"] === "string" ? firstErr["detail"] : null;
    const title = typeof firstErr?.["title"] === "string" ? firstErr["title"] : null;
    throw new Error(detail ?? title ?? "API Error");
  }

  return readResponseBody(response);
}

export function removeAuthToken(): void {
  localStorage.removeItem("tfe_token");
}
