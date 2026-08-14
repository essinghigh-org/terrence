import { expect, test } from "bun:test";
import {
  ApiError,
  bootstrapAuth,
  consumeAuthExpiry,
  expireAuthSession,
  extractFieldErrors,
  fetchAllApiPages,
  fetchApi,
  getAuthToken,
  getAuthTokenExpiry,
  isRefreshableSession,
  logoutAuthSession,
  readResponseBody,
  setAuthToken,
} from "../src/lib/api";

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

test("reads JSON, text, and empty API responses", async () => {
  expect(await readResponseBody(new Response(null, { status: 204 }))).toBeNull();
  expect(await readResponseBody(new Response('{"ok":true}', {
    headers: { "Content-Type": "application/vnd.api+json" },
  }))).toEqual({ ok: true });
  expect(await readResponseBody(new Response("plain text"))).toBe("plain text");
});

test("collects paginated API data and stops on a repeated page", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    calls.push(url);
    return Response.json(url.includes("page%5Bnumber%5D=2")
      ? { data: [{ id: "run-2" }], meta: { pagination: { "next-page": 2 } } }
      : { data: [{ id: "run-1" }], meta: { pagination: { "next-page": 2 } } });
  }) as typeof fetch;

  try {
    expect(await fetchAllApiPages<{ id: string }>("/workspaces/ws-1/runs")).toEqual([
      { id: "run-1" },
      { id: "run-2" },
    ]);
    expect(calls).toHaveLength(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("removes expired tokens before they are used", () => {
  setAuthToken("expired-token", Date.now() - 1);

  expect(getAuthToken()).toBeNull();
  expect(getAuthTokenExpiry()).toBeNull();
  expect(consumeAuthExpiry()).toBeTrue();
  expect(consumeAuthExpiry()).toBeFalse();
});

test("invalidates an authenticated session after a 401 response", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  setAuthToken("invalid-token");
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    calls.push(requestUrl(input));
    return Response.json(
      { errors: [{ status: "401", title: "Unauthorized", detail: "Token expired" }] },
      { status: 401 },
    );
  }) as typeof fetch;

  try {
    let errorMessage = "";
    try {
      await fetchApi("/account/details");
    } catch (error: unknown) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    expect(errorMessage).toBe("Token expired");
    expect(calls).toEqual(["/api/v2/account/details"]);
    expect(getAuthToken()).toBeNull();
    expect(consumeAuthExpiry()).toBeTrue();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses absolute /api/* endpoints verbatim instead of double-prefixing", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    calls.push(requestUrl(input));
    return Response.json({ version: "test", build: "unknown" });
  }) as typeof fetch;

  try {
    await fetchApi("/api/v1/metadata");
    expect(calls).toEqual(["/api/v1/metadata"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lets fetch infer content types for binary bodies", async () => {
  const originalFetch = globalThis.fetch;
  const contentTypes: (string | null)[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    contentTypes.push(new Headers(init?.headers).get("Content-Type"));
    return Response.json({ data: {} });
  }) as typeof fetch;

  try {
    await fetchApi("/binary", { method: "PUT", body: new Blob(["archive"]) });
    await fetchApi("/json", { method: "POST", body: "{}" });
    await fetchApi("/custom", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(contentTypes).toEqual([null, "application/vnd.api+json", "application/json"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rotates an expired browser session before sending the API request", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; authorization: string | null; credentials?: RequestCredentials }[] = [];
  setAuthToken("expired-access", Date.now() - 1, true);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("Authorization"),
      credentials: init?.credentials,
    });
    if (url.endsWith("/users/refresh")) {
      return Response.json({
        data: {
          attributes: {
            token: "rotated-access",
            "expired-at": new Date(Date.now() + 60_000).toISOString(),
          },
        },
      });
    }
    if (new Headers(init?.headers).get("Authorization") === "Bearer rotated-access") {
      return Response.json({ data: { id: "user-1" } });
    }
    return Response.json(
      { errors: [{ status: "401", title: "Unauthorized", detail: "Token expired" }] },
      { status: 401 },
    );
  }) as typeof fetch;

  try {
    expect(await fetchApi("/account/details")).toEqual({ data: { id: "user-1" } });
    expect(calls).toEqual([
      { url: "/api/v2/users/refresh", authorization: null, credentials: "same-origin" },
      { url: "/api/v2/account/details", authorization: "Bearer rotated-access", credentials: undefined },
    ]);
    expect(getAuthToken()).toBe("rotated-access");
    expect(isRefreshableSession()).toBeTrue();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("shares one refresh rotation across concurrent API retries", async () => {
  const originalFetch = globalThis.fetch;
  let oldAccessCalls = 0;
  let refreshCalls = 0;
  let releaseRefresh: (() => void) | undefined;
  const bothRequestsStarted = new Promise<void>((resolve): void => {
    releaseRefresh = resolve;
  });
  setAuthToken("old-access", Date.now() + 60_000, true);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const authorization = new Headers(init?.headers).get("Authorization");
    if (url.endsWith("/users/refresh")) {
      refreshCalls += 1;
      await bothRequestsStarted;
      return Response.json({
        data: {
          attributes: {
            token: "shared-access",
            "expired-at": new Date(Date.now() + 60_000).toISOString(),
          },
        },
      });
    }
    if (authorization === "Bearer old-access") {
      oldAccessCalls += 1;
      if (oldAccessCalls === 2) releaseRefresh?.();
      return Response.json({ errors: [{ status: "401", title: "Unauthorized" }] }, { status: 401 });
    }
    return Response.json({ data: { id: url } });
  }) as typeof fetch;

  try {
    const results = await Promise.all([fetchApi("/one"), fetchApi("/two")]);
    expect(results).toEqual([
      { data: { id: "/api/v2/one" } },
      { data: { id: "/api/v2/two" } },
    ]);
    expect(oldAccessCalls).toBe(2);
    expect(refreshCalls).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("logs out browser sessions server-side without treating API tokens as refreshable", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    calls.push(requestUrl(input));
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    setAuthToken("browser-access", Date.now() + 60_000, true);
    await logoutAuthSession();
    expect(calls).toEqual(["/api/v2/users/logout"]);
    expect(getAuthToken()).toBeNull();

    setAuthToken("api-token");
    await logoutAuthSession();
    expect(calls).toEqual(["/api/v2/users/logout"]);
    expect(getAuthToken()).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bootstrapAuth recovers a browser session through the refresh cookie", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    calls.push(url);
    if (url.endsWith("/users/refresh")) {
      return Response.json({
        data: {
          attributes: {
            token: "bootstrapped-access",
            "expired-at": new Date(Date.now() + 60_000).toISOString(),
          },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    expireAuthSession();
    expect(await bootstrapAuth()).toBe("bootstrapped-access");
    expect(calls).toEqual(["/api/v2/users/refresh"]);
    expect(getAuthToken()).toBe("bootstrapped-access");
    expect(isRefreshableSession()).toBe(true);
    // A second bootstrap reuses the in-memory token without another refresh.
    expect(await bootstrapAuth()).toBe("bootstrapped-access");
    expect(calls).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
    expireAuthSession();
  }
});

test("bootstrapAuth adopts and deletes a legacy localStorage token exactly once", async () => {
  const originalFetch = globalThis.fetch;
  let refreshed = 0;
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url.endsWith("/users/refresh")) {
      refreshed += 1;
      return Response.json(
        { errors: [{ status: "401", title: "Unauthorized" }] },
        { status: 401 },
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    expireAuthSession();
    localStorage.setItem("tfe_token", "legacy-token");
    localStorage.setItem("tfe_refreshable_session", "true");
    expect(await bootstrapAuth()).toBe("legacy-token");
    expect(getAuthToken()).toBe("legacy-token");
    // The sensitive value is gone from storage after adoption.
    expect(localStorage.getItem("tfe_token")).toBeNull();
    expect(localStorage.getItem("tfe_refreshable_session")).toBeNull();
    // A second bootstrap sees no token in storage and reuses memory.
    expect(await bootstrapAuth()).toBe("legacy-token");
    expect(refreshed).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    expireAuthSession();
    localStorage.removeItem("tfe_token");
    localStorage.removeItem("tfe_refreshable_session");
  }
});

test("bootstrapAuth returns null when no refresh session exists", async () => {
  const originalFetch = globalThis.fetch;
  let refreshed = 0;
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url.endsWith("/users/refresh")) {
      refreshed += 1;
      return Response.json(
        { errors: [{ status: "401", title: "Unauthorized" }] },
        { status: 401 },
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    expireAuthSession();
    expect(await bootstrapAuth()).toBeNull();
    expect(getAuthToken()).toBeNull();
    expect(refreshed).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extractFieldErrors maps JSON:API source.pointer entries to fields (26.9)", () => {
  const rawErrors = [
    { status: "422", title: "Unprocessable Entity", detail: "Name is required", source: { pointer: "/data/attributes/name" } },
    { status: "422", title: "Unprocessable Entity", detail: "URL must be valid", source: { pointer: "/data/attributes/url" } },
    // An entry with a pointer and detail is surfaced regardless of status
    { status: "404", title: "Not Found", detail: "gone", source: { pointer: "/data/attributes/repo" } },
    // No pointer - the generic title/detail path carries it, not field errors
    { status: "422", title: "X", detail: "no-pointer" },
  ] as Record<string, unknown>[];

  expect(extractFieldErrors(rawErrors)).toEqual({
    name: "Name is required",
    url: "URL must be valid",
    repo: "gone",
  });
});

test("extractFieldErrors ignores malformed pointers and empty details", () => {
  expect(extractFieldErrors([
    { detail: "d", source: { pointer: "/data/attributes/ok" } },
    { detail: "", source: { pointer: "/data/attributes/empty" } },
    { detail: "no pointer" },
  ] as Record<string, unknown>[])).toEqual({ ok: "d" });
});

test("fetchApi surfaces field-level 422 details on ApiError", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (): Promise<Response> => new Response(
    JSON.stringify({
      errors: [
        { status: "422", title: "Unprocessable Entity", detail: "Name is required", source: { pointer: "/data/attributes/name" } },
        { status: "422", title: "Unprocessable Entity", detail: "Bad URL", source: { pointer: "/data/attributes/url" } },
      ],
    }),
    { status: 422, headers: { "Content-Type": "application/vnd.api+json" } },
  )) as typeof fetch;

  try {
    setAuthToken("tk", Date.now() + 60_000);
    const caught = (await fetchApi("/notification-configurations").catch((e) => e)) as ApiError;
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.status).toBe(422);
    expect(caught.message).toBe("Name is required");
    expect(caught.fieldErrors).toEqual({ name: "Name is required", url: "Bad URL" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
