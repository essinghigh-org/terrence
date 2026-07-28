import { describe, expect, it } from "bun:test";
import { signedApiURL, validSignedApiURL } from "../../src/lib/utils";

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
