export const API_BASE_URL = "/api/v2";

export function getAuthToken() {
  return localStorage.getItem("tfe_token");
}

export function setAuthToken(token: string) {
  localStorage.setItem("tfe_token", token);
}

export async function readResponseBody(response: Response) {
  if (response.status === 204) return null;
  return response.headers.get("Content-Type")?.includes("json")
    ? response.json()
    : response.text();
}

export async function fetchApi(endpoint: string, options: RequestInit = {}) {
  const token = getAuthToken();
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/vnd.api+json");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem("tfe_token");
      window.location.href = "/login";
    }
    const errorBody = await response.json().catch(() => null);
    throw new Error(errorBody?.errors?.[0]?.detail || errorBody?.errors?.[0]?.title || "API Error");
  }

  return readResponseBody(response);
}

export function removeAuthToken() {
  localStorage.removeItem("tfe_token");
}
