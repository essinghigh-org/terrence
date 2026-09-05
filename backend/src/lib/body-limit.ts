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
// Upload paths are matched by suffix (ends with /upload, /json-upload, or
// /json-outputs-upload, plus the agent filesystem path): configuration
// versions, policy sets, state versions, registry module versions, and
// policy content uploads all follow that shape.

export const API_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Request body exceeds the ${limit} byte limit`);
    this.name = "BodyTooLargeError";
  }
}

/** True for the archive-upload paths that keep the 100 MiB server limit. */
export function isUploadPath(pathname: string): boolean {
  return pathname.endsWith("/upload")
    || pathname.endsWith("/json-upload")
    || pathname.endsWith("/json-outputs-upload")
    || /^\/api\/agent\/jobs\/[^/]+\/filesystem$/.test(pathname);
}

/**
 * Reads the request body as text, aborting once `limit` bytes are exceeded.
 * Throws BodyTooLargeError instead of buffering an unbounded chunked body.
 */
export async function readTextWithLimit(request: Request, limit: number): Promise<string> {
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
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
  return new TextDecoder().decode(concatChunks(chunks));
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum: number, chunk: Uint8Array): number => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
