// Request body size guarding.
//
// The server-level maxRequestBodySize is 100 MiB because configuration
// version and module archives legitimately reach that size. That limit would
// let every other endpoint buffer up to 100 MiB before Bun rejects it, which
// is a cheap DoS surface on login, JSON APIs, and webhooks. This module
// enforces a much smaller cap for everything except the archive upload
// paths, using the Content-Length header when present (early rejection, no
// buffering) and a capped stream read for chunked bodies.
//
// Upload paths are an explicit route-shape allowlist. Do not classify by a
// caller-controlled suffix: otherwise an unauthenticated request to an
// arbitrary nonexistent /upload path can opt into the 100 MiB server cap.
import type { DeepReadonly } from "./types";

export const API_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Request body exceeds the ${limit} byte limit`);
    this.name = "BodyTooLargeError";
  }
}

const LARGE_UPLOAD_PATHS: readonly RegExp[] = [
  /^\/api\/v2\/configuration-versions\/[^/]+\/upload$/,
  /^\/api\/v2\/state-versions\/[^/]+\/(?:upload|json-upload|json-outputs-upload)$/,
  /^\/api\/v2\/workspaces\/[^/]+\/state-versions\/upload$/,
  /^\/api\/v2\/policies\/[^/]+\/upload$/,
  /^\/api\/v2\/policy-set-versions\/[^/]+\/upload$/,
  /^\/api\/v2\/registry-module-versions\/[^/]+\/upload$/,
  /^\/api\/v2\/module-test-configuration-versions\/[^/]+\/upload$/,
  /^\/api\/v2\/stack-configurations\/[^/]+\/upload$/,
  /^\/api\/agent\/jobs\/[^/]+\/upload$/,
  /^\/api\/agent\/jobs\/[^/]+\/filesystem$/,
] as const;

/** True for the registered large-body upload paths that keep the 100 MiB server limit. */
export function isUploadPath(pathname: string): boolean {
  return LARGE_UPLOAD_PATHS.some((pattern): boolean => pattern.test(pathname));
}

/**
 * Reads a request or response body as bytes, aborting once `limit` bytes are exceeded.
 * Throws BodyTooLargeError instead of buffering an unbounded chunked body.
 */
export async function readBytesWithLimit(
  request: DeepReadonly<Pick<Request, "body">>,
  limit: number,
): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        throw new BodyTooLargeError(limit);
      }
      chunks.push(value);
    }
  } finally {
    // The loop only exits via `done` (stream fully consumed) or the throw
    // above; cancel on the error path so the connection is released.
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed; cancellation is best-effort.
    }
  }
  return concatChunks(chunks);
}

/** Text counterpart used by JSON, webhook, form, and log parsers. */
export async function readTextWithLimit(request: DeepReadonly<Pick<Request, "body">>, limit: number): Promise<string> {
  return new TextDecoder().decode(await readBytesWithLimit(request, limit));
}

function concatChunks(chunks: readonly DeepReadonly<Uint8Array>[]): Uint8Array {
  const total = chunks.reduce((sum: number, chunk: DeepReadonly<Uint8Array>): number => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
