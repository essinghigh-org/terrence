import { describe, expect, it } from "bun:test";
import { signedApiURL, validSignedApiURL, workspaceRelationshipIds, validateExternalUrl, type DeepReadonly } from "../../src/lib/utils";

// An empty (but not-expired) signed URL is always valid against the same
// SIGNED_URL_SECRET the module uses, so we use signedApiURL itself as a
// signature oracle to construct valid URLs we can then verify.

type RequestWithUrl = { readonly url: string; readonly method: string };

describe("validSignedApiURL", () => {
  function makeRequest(url: string, method = "GET"): RequestWithUrl {
    return { url, method };
  }

  it("accepts a fresh signature", () => {
    const path = "/api/v2/test";
    const fakeReq = makeRequest("http://localhost");
    const signed = signedApiURL(fakeReq, path, "GET", 3600);
    const requestWithSigned = makeRequest(signed, "GET");
    expect(validSignedApiURL(requestWithSigned, path, "GET")).toBe(true);
  });

  it("rejects a missing expires param", () => {
    const url = new URL("http://localhost/api/v2/test");
    url.searchParams.set("signature", "abc123");
    expect(validSignedApiURL(makeRequest(url.toString()), "/api/v2/test")).toBe(false);
  });

  it("rejects a missing signature param", () => {
    const url = new URL("http://localhost/api/v2/test");
    url.searchParams.set("expires", String(Math.floor(Date.now() / 1000) + 600));
    expect(validSignedApiURL(makeRequest(url.toString()), "/api/v2/test")).toBe(false);
  });

  it("rejects an already-expired signature", () => {
    const path = "/api/v2/test";
    const url = new URL("http://localhost" + path);
    // Set expires to a past timestamp
    url.searchParams.set("expires", String(Math.floor(Date.now() / 1000) - 60));
    url.searchParams.set("signature", "abc123def456");
    expect(validSignedApiURL(makeRequest(url.toString()), path, "GET")).toBe(false);
  });

  it("rejects a non-numeric expires param", () => {
    const url = new URL("http://localhost/api/v2/test");
    url.searchParams.set("expires", "abc");
    url.searchParams.set("signature", "abc123");
    expect(validSignedApiURL(makeRequest(url.toString()), "/api/v2/test")).toBe(false);
  });

  it("rejects a signature with wrong method", () => {
    const path = "/api/v2/test";
    const fakeReq = makeRequest("http://localhost");
    const signed = signedApiURL(fakeReq, path, "PUT", 3600);
    const requestWithSigned = makeRequest(signed, "PUT");
    expect(validSignedApiURL(requestWithSigned, path, "GET")).toBe(false);
  });

  it("rejects a signature with wrong path", () => {
    const path = "/api/v2/test";
    const fakeReq = makeRequest("http://localhost");
    const signed = signedApiURL(fakeReq, path, "GET", 3600);
    const requestWithSigned = makeRequest(signed, "GET");
    expect(validSignedApiURL(requestWithSigned, "/api/v2/wrong", "GET")).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const path = "/api/v2/test";
    const fakeReq = makeRequest("http://localhost");
    const signed = signedApiURL(fakeReq, path, "GET", 3600);
    // tamper with the signature
    const url = new URL(signed);
    const originalSig = url.searchParams.get("signature") ?? "";
    url.searchParams.set("signature", originalSig.replace(/[0-9a-f]/g, (c: string) => c === "a" ? "b" : "a"));
    expect(validSignedApiURL(makeRequest(url.toString()), path, "GET")).toBe(false);
  });

  it("rejects a wrong-length signature", () => {
    const path = "/api/v2/test";
    const url = new URL("http://localhost" + path);
    url.searchParams.set("expires", String(Math.floor(Date.now() / 1000) + 600));
    url.searchParams.set("signature", "short");
    expect(validSignedApiURL(makeRequest(url.toString()), path, "GET")).toBe(false);
  });
});

describe("workspaceRelationshipIds", () => {
  it("extracts workspace IDs from a valid payload", () => {
    const result = workspaceRelationshipIds({
      data: [
        { id: "ws-1", type: "workspaces" },
        { id: "ws-2", type: "workspaces" },
      ],
    });
    expect(result).toEqual(["ws-1", "ws-2"]);
  });

  it("deduplicates repeated IDs", () => {
    const result = workspaceRelationshipIds({
      data: [
        { id: "ws-1", type: "workspaces" },
        { id: "ws-1", type: "workspaces" },
      ],
    });
    expect(result).toEqual(["ws-1"]);
  });

  it("returns empty array for empty data", () => {
    expect(workspaceRelationshipIds({ data: [] })).toEqual([]);
  });

  it("returns undefined for missing data key", () => {
    expect(workspaceRelationshipIds({})).toBeUndefined();
  });

  it("returns undefined when payload is null", () => {
    expect(workspaceRelationshipIds(null)).toBeUndefined();
  });

  it("returns undefined when data is not an array", () => {
    expect(workspaceRelationshipIds({ data: "not-an-array" })).toBeUndefined();
  });

  it("returns undefined when items have wrong type", () => {
    expect(workspaceRelationshipIds({
      data: [{ id: "proj-1", type: "projects" }],
    })).toBeUndefined();
  });
});

describe("validateExternalUrl", () => {
  it("accepts a public HTTPS URL", () => {
    expect(validateExternalUrl("https://example.com/hook")).toBeNull();
  });

  it("accepts a public HTTP URL", () => {
    expect(validateExternalUrl("http://example.com/hook")).toBeNull();
  });

  it("rejects loopback", () => {
    expect(validateExternalUrl("http://127.0.0.1:3000/hook")).toBe(
      "URL points to a private or loopback address",
    );
  });

  it("rejects localhost", () => {
    expect(validateExternalUrl("http://localhost:3000/hook")).toBe(
      "URL points to a private or loopback address",
    );
  });

  it("rejects private 10.x", () => {
    expect(validateExternalUrl("http://10.0.1.5/hook")).toBe(
      "URL points to a private or loopback address",
    );
  });

  it("rejects private 192.168.x", () => {
    expect(validateExternalUrl("http://192.168.1.1/hook")).toBe(
      "URL points to a private or loopback address",
    );
  });

  it("rejects invalid URL strings", () => {
    expect(validateExternalUrl("not-a-url")).toBe("Invalid URL");
  });

  it("rejects non-http protocols", () => {
    expect(validateExternalUrl("ftp://example.com")).toBe(
      "Only http and https URLs are allowed",
    );
  });

  it("allows private IPs when allowPrivate is true", () => {
    expect(validateExternalUrl("http://127.0.0.1:3000/hook", true)).toBeNull();
  });
});

describe("DeepReadonly", () => {
  it("preserves callable function types instead of mapping them as objects", () => {
    type Handler = DeepReadonly<(value: string) => number>;
    const handler: Handler = (value: string): number => value.length;
    expect(handler("abcd")).toBe(4);
  });

  it("keeps scalar and array branches readonly", () => {
    type List = DeepReadonly<{ readonly items: string[] }>;
    const list: List = { items: ["a"] };
    expect(list.items[0]).toBe("a");
  });
});
