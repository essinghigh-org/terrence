import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { app } from "../../src/app";
import { API_BODY_LIMIT_BYTES } from "../../src/lib/body-limit";

// The 100 MiB server-level limit exists for configuration/state/module
// archives. Every other endpoint must reject oversized bodies cheaply:
// Content-Length is checked in onRequest before any buffering, and chunked
// bodies are capped during onParse (BodyTooLargeError -> 413).
describe("request body size guard", () => {
  const previousSecret = process.env.GITHUB_WEBHOOK_SECRET;

  beforeAll(() => {
    process.env.GITHUB_WEBHOOK_SECRET = "guard-secret";
  });

  afterAll(() => {
    if (previousSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
  });

  function oversizedBody(): string {
    return "x".repeat(API_BODY_LIMIT_BYTES + 1024);
  }

  test("rejects a JSON API request whose Content-Length exceeds the limit with 413", async () => {
    const response = await app.handle(new Request("http://localhost/api/v2/users/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.api+json",
        "Content-Length": String(API_BODY_LIMIT_BYTES + 1024),
      },
      body: oversizedBody(),
    }));
    expect(response.status).toBe(413);
    const body = await response.json() as { errors?: { title?: string }[] };
    expect(body.errors?.[0]?.title).toBe("Payload Too Large");
  });

  test("rejects a chunked JSON API body (no Content-Length) over the limit with 413", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(oversizedBody()));
        controller.close();
      },
    });
    const response = await app.handle(new Request("http://localhost/api/v2/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: stream,
    }));
    expect(response.status).toBe(413);
    const body = await response.json() as { errors?: { title?: string }[] };
    expect(body.errors?.[0]?.title).toBe("Payload Too Large");
  });

  test("rejects a chunked application/json body (no Content-Length) over the limit with 413", async () => {
    // application/json rides Elysia's default parse path; the cap must apply
    // there too, not just to vnd.api+json.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(oversizedBody()));
        controller.close();
      },
    });
    const response = await app.handle(new Request("http://localhost/api/v2/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
    }));
    expect(response.status).toBe(413);
  });

  test("allows normal-sized JSON API bodies through the guard", async () => {
    const response = await app.handle(new Request("http://localhost/api/v2/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({ data: { attributes: { username: "nobody", password: "wrong" } } }),
    }));
    // Not a size rejection: login semantics (401 for bad credentials), or at
    // minimum anything but 413.
    expect(response.status).not.toBe(413);
  });

  test("caps webhook bodies at the same limit", async () => {
    const response = await app.handle(new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(API_BODY_LIMIT_BYTES + 1024),
      },
      body: oversizedBody(),
    }));
    expect(response.status).toBe(413);
  });

  test("does not apply the small limit to archive upload paths", async () => {
    // The upload route itself validates auth/existence; the size guard must
    // not intercept it (10 MiB is far beyond the JSON limit but below the
    // 100 MiB server cap, so the route's own checks decide the status).
    const response = await app.handle(new Request("http://localhost/api/v2/configuration-versions/cv-guard-test/upload", {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: "x".repeat(10 * 1024 * 1024),
    }));
    expect(response.status).not.toBe(413);
  });
});
