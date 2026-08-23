import { open, writeFile } from "node:fs/promises";

/** Persist an upload without retaining a second in-memory copy. */
export async function persistUploadBody(body: unknown, request: Request, path: string, limit: number): Promise<number> {
  const direct = body instanceof ArrayBuffer
    ? new Uint8Array(body)
    : ArrayBuffer.isView(body)
      ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
      : typeof body === "string"
        ? new TextEncoder().encode(body)
        : body !== null && typeof body === "object" && (Array.isArray(body) || Object.getPrototypeOf(body) === Object.prototype)
          ? new TextEncoder().encode(JSON.stringify(body))
          : null;
  if (direct !== null) {
    if (direct.byteLength > limit) throw new Error("too-large");
    await writeFile(path, direct, { mode: 0o600 });
    return direct.byteLength;
  }
  const stream = body instanceof Blob ? body.stream() : request.body;
  const reader = stream?.getReader();
  if (reader === undefined) throw new Error("empty");
  const file = await open(path, "w", 0o600);
  let total = 0;
  let failure: unknown;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - total) throw new Error("too-large");
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(value.subarray(offset));
        if (bytesWritten <= 0) throw new Error("upload write made no progress");
        offset += bytesWritten;
        total += bytesWritten;
      }
    }
  } catch (error: unknown) {
    failure = error;
  } finally {
    try {
      await file.close();
    } catch (error: unknown) {
      failure ??= error;
    }
    try {
      await reader.cancel();
    } catch (error: unknown) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
  return total;
}
