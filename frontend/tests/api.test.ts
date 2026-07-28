import { expect, test } from "bun:test";
import {
  consumeAuthExpiry,
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

test("rotates a browser session and retries one failed API request", async () => {
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
      { url: "/api/v2/account/details", authorization: "Bearer expired-access", credentials: undefined },
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
