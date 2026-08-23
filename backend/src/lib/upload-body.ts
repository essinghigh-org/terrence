import { open, writeFile } from "node:fs/promises";

/** Persist an upload without retaining a second in-memory copy. */
export async function persistUploadBody(body: unknown, request: Request, path: string, limit: number): Promise<number> {
  const direct = body instanceof ArrayBuffer
    ? new Uint8Array(body)
    : ArrayBuffer.isView(body)
      ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
      : typeof body === "string"
        ? new TextEncoder().encode(body)
        : body !== null && typeof body === "object" && !(body instanceof Blob)
          ? new TextEncoder().encode(JSON.stringify(body))
          : null;
  if (direct !== null) {
    if (direct.byteLength > limit) throw new Error("too-large");
    await writeFile(path, direct, { mode: 0o600 });
    return direct.byteLength;
  }
  const stream = body instanceof Blob ? body.stream() : request.body;
  const reader = stream?.getReader();
  if (reader === undefined) return 0;
  const file = await open(path, "w", 0o600);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("too-large");
      await file.write(value);
    }
  } finally {
    await file.close();
    await reader.cancel().catch(() => undefined);
  }
  return total;
}
