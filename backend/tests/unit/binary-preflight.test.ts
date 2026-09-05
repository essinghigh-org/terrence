import { afterEach, describe, expect, test } from "bun:test";
import {
  BinaryDownloadError,
  closestKnownVersion,
  fetchBinaryArchive,
  isRetryableBinaryDownloadError,
  resolveBinaryDownloadRetries,
  resolveBinaryDownloadTimeoutMs,
} from "../../src/binaryManager";

// Issue #602: download resilience knobs and closest-version helper.
const originalFetch = globalThis.fetch;
const ENV_KEYS = ["TERRENCE_BINARY_DOWNLOAD_TIMEOUT_MS", "TERRENCE_BINARY_DOWNLOAD_RETRIES"] as const;
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

afterEach((): void => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv.get(key);
    if (saved === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = saved;
  }
  savedEnv.clear();
  globalThis.fetch = originalFetch;
});

describe("resolveBinaryDownloadTimeoutMs", (): void => {
  test("defaults to 120s", (): void => {
    setEnv("TERRENCE_BINARY_DOWNLOAD_TIMEOUT_MS", undefined);
    expect(resolveBinaryDownloadTimeoutMs()).toBe(120_000);
  });

  test("honors an explicit override", (): void => {
    setEnv("TERRENCE_BINARY_DOWNLOAD_TIMEOUT_MS", "5000");
    expect(resolveBinaryDownloadTimeoutMs()).toBe(5000);
  });

  test("rejects non-positive and non-numeric values", (): void => {
    for (const value of ["0", "-1", "abc", ""]) {
      setEnv("TERRENCE_BINARY_DOWNLOAD_TIMEOUT_MS", value);
      expect(resolveBinaryDownloadTimeoutMs()).toBe(120_000);
    }
  });
});

describe("resolveBinaryDownloadRetries", (): void => {
  test("defaults to 2", (): void => {
    setEnv("TERRENCE_BINARY_DOWNLOAD_RETRIES", undefined);
    expect(resolveBinaryDownloadRetries()).toBe(2);
  });

  test("honors 0 and small counts", (): void => {
    setEnv("TERRENCE_BINARY_DOWNLOAD_RETRIES", "0");
    expect(resolveBinaryDownloadRetries()).toBe(0);
    setEnv("TERRENCE_BINARY_DOWNLOAD_RETRIES", "3");
    expect(resolveBinaryDownloadRetries()).toBe(3);
  });

  test("caps at 5 and rejects negatives", (): void => {
    setEnv("TERRENCE_BINARY_DOWNLOAD_RETRIES", "99");
    expect(resolveBinaryDownloadRetries()).toBe(5);
    setEnv("TERRENCE_BINARY_DOWNLOAD_RETRIES", "-1");
    expect(resolveBinaryDownloadRetries()).toBe(2);
  });
});

describe("closestKnownVersion", (): void => {
  const candidates = ["1.9.0", "1.9.8", "1.10.0", "1.2.3"];

  test("picks the highest version at or below the target", (): void => {
    expect(closestKnownVersion("1.9.9", candidates)).toBe("1.9.8");
  });

  test("an exact hit resolves to itself", (): void => {
    expect(closestKnownVersion("1.9.8", candidates)).toBe("1.9.8");
  });

  test("a target below everything falls back to the highest known", (): void => {
    expect(closestKnownVersion("0.9.0", candidates)).toBe("1.10.0");
  });

  test("a target above everything picks the highest below", (): void => {
    expect(closestKnownVersion("9.9.9", candidates)).toBe("1.10.0");
  });

  test("empty candidates resolve to undefined", (): void => {
    expect(closestKnownVersion("1.9.9", [])).toBeUndefined();
  });
});

describe("isRetryableBinaryDownloadError", (): void => {
  test("only retryable download errors retry", (): void => {
    expect(isRetryableBinaryDownloadError(new BinaryDownloadError("slow", true))).toBe(true);
    expect(isRetryableBinaryDownloadError(new BinaryDownloadError("missing", false))).toBe(false);
    expect(isRetryableBinaryDownloadError(new Error("slow"))).toBe(false);
    expect(isRetryableBinaryDownloadError("slow")).toBe(false);
  });
});

describe("fetchBinaryArchive", (): void => {
  test("returns the body on success", async (): Promise<void> => {
    globalThis.fetch = (async (): Promise<Response> => new Response("archive-bytes")) as unknown as typeof fetch;
    const buffer = await fetchBinaryArchive("https://example.invalid/pkg.zip", 5000);
    expect(new TextDecoder().decode(buffer)).toBe("archive-bytes");
  });

  test("404 fails fast as non-retryable", async (): Promise<void> => {
    globalThis.fetch = (async (): Promise<Response> => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const failure = await fetchBinaryArchive("https://example.invalid/pkg.zip", 5000).then(
      (): null => null,
      (err: unknown): unknown => err,
    );
    expect(failure).toBeInstanceOf(BinaryDownloadError);
    expect((failure as BinaryDownloadError).retryable).toBe(false);
    expect((failure as Error).message).toContain("404");
  });

  test("500 is retryable", async (): Promise<void> => {
    globalThis.fetch = (async (): Promise<Response> => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const failure = await fetchBinaryArchive("https://example.invalid/pkg.zip", 5000).then(
      (): null => null,
      (err: unknown): unknown => err,
    );
    expect(failure).toBeInstanceOf(BinaryDownloadError);
    expect((failure as BinaryDownloadError).retryable).toBe(true);
  });

  test("oversize content-length fails fast without downloading", async (): Promise<void> => {
    let fetched = false;
    globalThis.fetch = (async (): Promise<Response> => {
      fetched = true;
      return new Response("x", {
        status: 200,
        headers: { "content-length": String(200 * 1024 * 1024) },
      });
    }) as unknown as typeof fetch;
    const failure = await fetchBinaryArchive("https://example.invalid/pkg.zip", 5000).then(
      (): null => null,
      (err: unknown): unknown => err,
    );
    expect(fetched).toBe(true);
    expect(failure).toBeInstanceOf(BinaryDownloadError);
    expect((failure as BinaryDownloadError).retryable).toBe(false);
    expect((failure as Error).message).toContain("too large");
  });

  test("a hung download surfaces a retryable timeout", async (): Promise<void> => {
    // A signal-aware hang: rejects with the signal reason on abort, like the
    // real fetch does when AbortSignal.timeout fires.
    globalThis.fetch = (((_input: unknown, init?: { signal?: AbortSignal }): Promise<Response> =>
      new Promise((_resolve, reject): void => {
        init?.signal?.addEventListener("abort", (): void => {
          const reason = init.signal?.reason;
          reject(reason instanceof Error ? reason : new Error("aborted"));
        });
      })) as unknown) as typeof fetch;
    const failure = await fetchBinaryArchive("https://example.invalid/pkg.zip", 10).then(
      (): null => null,
      (err: unknown): unknown => err,
    );
    expect(failure).toBeInstanceOf(BinaryDownloadError);
    expect((failure as BinaryDownloadError).retryable).toBe(true);
    expect((failure as Error).message).toContain("timed out");
  });

  test("network failures are retryable", async (): Promise<void> => {
    globalThis.fetch = (async (): Promise<Response> => {
      throw new TypeError("connection reset");
    }) as unknown as typeof fetch;
    const failure = await fetchBinaryArchive("https://example.invalid/pkg.zip", 5000).then(
      (): null => null,
      (err: unknown): unknown => err,
    );
    expect(failure).toBeInstanceOf(BinaryDownloadError);
    expect((failure as BinaryDownloadError).retryable).toBe(true);
  });
});
