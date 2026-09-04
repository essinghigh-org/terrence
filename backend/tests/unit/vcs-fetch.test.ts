import { afterEach, describe, expect, test } from "bun:test";
import { fetchVcsUrl } from "../../src/lib/webhooks";
import { setExternalUrlTransportForTests } from "../../src/lib/url-safety";

type ObservedRequest = Readonly<{
  authorization: string | null;
  body: string | null;
  contentType: string | null;
  method: string;
  url: string;
}>;

function observe(target: Readonly<{ url: string }>, init: Readonly<{ body?: string; headers?: Readonly<Record<string, string>>; method: string }>): ObservedRequest {
  const headers = new Headers(init.headers);
  return {
    authorization: headers.get("authorization"),
    body: init.body ?? null,
    contentType: headers.get("content-type"),
    method: init.method,
    url: target.url,
  };
}

afterEach(() => {
  setExternalUrlTransportForTests(undefined);
});

describe("validated VCS transport", () => {
  test("does not send credentials over HTTP or retain them on an insecure redirect", async () => {
    const requests: ObservedRequest[] = [];
    setExternalUrlTransportForTests(async (target, init): Promise<Response> => {
      requests.push(observe(target, init));
      return new URL(target.url).pathname === "/start"
        ? new Response(null, { status: 302, headers: { Location: "http://other-vcs.example.test/final" } })
        : new Response("ok");
    });

    const blocked = await fetchVcsUrl("http://vcs.example.test/start", {
      headers: { Authorization: "Bearer secret" },
      timeoutMs: 1_000,
    });
    expect(blocked.status).toBe(422);
    expect(requests).toHaveLength(0);

    const redirected = await fetchVcsUrl("https://vcs.example.test/start", {
      headers: { Authorization: "Bearer secret" },
      timeoutMs: 1_000,
    });
    expect(redirected.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.authorization).toBe("Bearer secret");
    expect(requests[1]).toMatchObject({
      authorization: null,
      url: "http://other-vcs.example.test/final",
    });
  });

  test("matches native Fetch method and body handling for every redirect status", async () => {
    const requests: ObservedRequest[] = [];
    let redirectStatus = 301;
    setExternalUrlTransportForTests(async (target, init): Promise<Response> => {
      requests.push(observe(target, init));
      return new URL(target.url).pathname === "/start"
        ? new Response(null, { status: redirectStatus, headers: { Location: "https://vcs.example.test/final" } })
        : new Response("ok");
    });

    for (const status of [301, 302, 303, 307, 308]) {
      redirectStatus = status;
      requests.length = 0;
      const response = await fetchVcsUrl("https://vcs.example.test/start", {
        body: "payload",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        method: "POST",
        timeoutMs: 1_000,
      });
      expect(response.status).toBe(200);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        authorization: "Bearer secret",
        body: "payload",
        contentType: "application/json",
        method: "POST",
      });
      expect(requests[1]).toMatchObject({
        authorization: "Bearer secret",
        body: [301, 302, 303].includes(status) ? null : "payload",
        contentType: [301, 302, 303].includes(status) ? null : "application/json",
        method: [301, 302, 303].includes(status) ? "GET" : "POST",
      });
    }
  });
});
