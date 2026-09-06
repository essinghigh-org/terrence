import { open, rename, rm, writeFile } from "node:fs/promises";

function directUploadBytes(body: unknown): Uint8Array | null {
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body === null || typeof body !== "object") return null;
  if (!Array.isArray(body) && Object.getPrototypeOf(body) !== Object.prototype) return null;
  return new TextEncoder().encode(JSON.stringify(body));
}

async function writeUploadStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  path: string,
  limit: number,
): Promise<number> {
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
  if (total === 0) throw new Error("empty");
  return total;
}

/** Persist an upload without retaining a second in-memory copy. */
export async function persistUploadBody(
  body: unknown,
  request: Request,
  path: string,
  limit: number,
  canPublish?: () => Promise<boolean>,
): Promise<number> {
  // A disconnected agent must never leave a truncated artifact at the final
  // path. Every upload is written to a private temporary file and published
  // with one rename after the body has been consumed.
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const direct = directUploadBytes(body);
    if (direct !== null) {
      if (direct.byteLength > limit) throw new Error("too-large");
      if (direct.byteLength === 0) throw new Error("empty");
      await writeFile(temporary, direct, { mode: 0o600, flag: "wx" });
      if (canPublish !== undefined && !await canPublish()) throw new Error("stale-agent-lease");
      await rename(temporary, path);
      return direct.byteLength;
    }
    const stream = body instanceof Blob ? body.stream() : request.body;
    const reader = stream?.getReader();
    if (reader === undefined) throw new Error("empty");
    const size = await writeUploadStream(reader, temporary, limit);
    if (canPublish !== undefined && !await canPublish()) throw new Error("stale-agent-lease");
    await rename(temporary, path);
    return size;
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch((): void => { /* best effort */ });
    throw error;
  }
}
