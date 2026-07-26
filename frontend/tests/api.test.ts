import { expect, test } from "bun:test";
import { readResponseBody } from "../src/lib/api";

test("reads JSON, text, and empty API responses", async () => {
  expect(await readResponseBody(new Response(null, { status: 204 }))).toBeNull();
  expect(await readResponseBody(new Response('{"ok":true}', {
    headers: { "Content-Type": "application/vnd.api+json" },
  }))).toEqual({ ok: true });
  expect(await readResponseBody(new Response("plain text"))).toBe("plain text");
});
