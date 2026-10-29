import { afterEach, expect, test } from "bun:test";
import { expireAuthSession, fetchRunLogTail, setAuthToken } from "../src/lib/api";

const originalFetch = globalThis.fetch;
const logSliceBytes = 1024 * 1024;

afterEach((): void => {
  globalThis.fetch = originalFetch;
  expireAuthSession();
});

test.each([
  ["é", 1],
  ["€", 1],
  ["€", 2],
  ["😀", 1],
  ["😀", 2],
  ["😀", 3],
] as const)(
  "log tails preserve %s split after %i UTF-8 bytes by the server budget",
  async (character, split): Promise<void> => {
    setAuthToken("log-tail-test");
    const prefix = "x".repeat(logSliceBytes - split);
    const whole = `${prefix}${character} tail`;
    const bytes = new TextEncoder().encode(whole);
    const requestedOffsets: number[] = [];
    // SAFETY: this mock implements the fetch call surface exercised by log reads.
    globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const offset = Number(new URL(raw, "http://terrence.local").searchParams.get("offset"));
      requestedOffsets.push(offset);
      return Promise.resolve(
        new Response(bytes.slice(offset, offset + logSliceBytes), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "X-Terrence-Log-Total-Bytes": String(bytes.byteLength),
            "X-Terrence-Log-Truncated": String(offset + logSliceBytes < bytes.byteLength),
          },
        }),
      );
    }) as typeof fetch;

    const first = await fetchRunLogTail("run-utf8", "plan", 0);
    expect(first.chunk).toBe(prefix);
    expect(first.nextOffset).toBe(prefix.length);
    expect(first.totalBytes).toBe(bytes.byteLength);
    expect(first.totalKnown).toBe(true);
    expect(first.truncated).toBe(true);
    const second = await fetchRunLogTail("run-utf8", "plan", first.nextOffset);
    expect(first.chunk + second.chunk).toBe(whole);
    expect(second.nextOffset).toBe(bytes.byteLength);
    expect(requestedOffsets).toEqual([0, prefix.length]);
  },
);

test("log tails count response bytes when a total header is unavailable", async (): Promise<void> => {
  setAuthToken("log-tail-test");
  // SAFETY: this mock implements the fetch call surface exercised by log reads.
  globalThis.fetch = ((_input: string | URL | Request): Promise<Response> =>
    Promise.resolve(
      new Response(new Uint8Array([0x61, 0xf0, 0x9f]), { headers: { "Content-Type": "text/plain" } }),
    )) as typeof fetch;

  const tail = await fetchRunLogTail("run-utf8", "apply", 10);
  expect(tail.chunk).toBe("a");
  expect(tail.nextOffset).toBe(11);
  expect(tail.totalBytes).toBe(13);
  expect(tail.totalKnown).toBe(false);
});
