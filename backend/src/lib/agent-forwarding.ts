import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db";
import { agentForwardedRequests } from "../db/schema";

const MAX_FORWARD_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_FORWARD_TIMEOUT_MS = 60_000;
const FORWARDED_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Purge forwarded request rows older than the retention window. Completed
 *  and errored rows have already had their request headers/body cleared at
 *  completion time; this drops the rows themselves so the table cannot grow
 *  without bound and stale pre-completion rows (which still hold forwarded
 *  credentials) do not persist indefinitely. */
export async function purgeExpiredForwardedRequests(): Promise<number> {
  const cutoff = Date.now() - FORWARDED_REQUEST_RETENTION_MS;
  const deleted = await db.delete(agentForwardedRequests)
    .where(lt(agentForwardedRequests.createdAt, cutoff))
    .returning({ id: agentForwardedRequests.id });
  return deleted.length;
}

function responseHeaders(headers: Readonly<Record<string, readonly string[]>> | null): Headers {
  const result = new Headers();
  for (const [name, values] of Object.entries(headers ?? {})) {
    for (const value of values) result.append(name, value);
  }
  return result;
}

/** Read a request body to bytes while enforcing a cap: a caller sending an
 *  arbitrarily large streamed body must not exhaust backend memory before
 *  the size limit runs. Throws once the accumulated byte count exceeds
 *  the cap, cancelling the remaining stream. */
async function readBodyCapped(init: BodyInit, capBytes: number): Promise<Buffer> {
  if (typeof init === "string") {
    const bytes = Buffer.from(init);
    if (bytes.length > capBytes) throw new Error(`Forwarded request body exceeds ${capBytes} bytes`);
    return bytes;
  }
  if (init instanceof Uint8Array) {
    if (init.byteLength > capBytes) throw new Error(`Forwarded request body exceeds ${capBytes} bytes`);
    return Buffer.from(init);
  }
  if (init instanceof ArrayBuffer) {
    if (init.byteLength > capBytes) throw new Error(`Forwarded request body exceeds ${capBytes} bytes`);
    return Buffer.from(init);
  }
  if (init instanceof Blob) {
    if (init.size > capBytes) throw new Error(`Forwarded request body exceeds ${capBytes} bytes`);
    return Buffer.from(await init.arrayBuffer());
  }
  // FormData / URLSearchParams: size is not knowable without serialization;
  // serialize (bounded by the server body limit already) and check the cap.
  if (!(init instanceof ReadableStream)) {
    const bytes = Buffer.from(await new Response(init).arrayBuffer());
    if (bytes.length > capBytes) throw new Error(`Forwarded request body exceeds ${capBytes} bytes`);
    return bytes;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = (init as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > capBytes) throw new Error(`Forwarded request body exceeds ${capBytes} bytes`);
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function forwardFetch(
  agentPoolId: string,
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol) || url.username !== "" || url.password !== "") {
    throw new Error("Forwarded requests require an HTTP(S) URL without embedded credentials");
  }
  const method = (init.method ?? "GET").toUpperCase();
  if (!/^[A-Z]+$/.test(method) || method === "CONNECT" || method === "TRACE") {
    throw new Error("Forwarded request method is not supported");
  }
  const requestHeaders: Record<string, string[]> = {};
  new Headers(init.headers).forEach((value, name): void => { requestHeaders[name] = [value]; });
  const bodyBytes = init.body === undefined || init.body === null
    ? null
    : await readBodyCapped(init.body, MAX_FORWARD_BODY_BYTES);
  if ((bodyBytes?.byteLength ?? 0) > MAX_FORWARD_BODY_BYTES) throw new Error("Forwarded request body exceeds 10 MiB");

  const id = `afwd-${crypto.randomUUID()}`;
  await db.insert(agentForwardedRequests).values({
    id,
    agentPoolId,
    method,
    url: url.toString(),
    headers: requestHeaders,
    body: bodyBytes === null ? null : bodyBytes.toString("base64"),
    status: "queued",
    createdAt: Date.now(),
  });

  const timeoutMs = Number(process.env.TERRENCE_AGENT_FORWARD_TIMEOUT_MS ?? DEFAULT_FORWARD_TIMEOUT_MS);
  const deadline = Date.now() + (Number.isFinite(timeoutMs) ? Math.max(1_000, Math.min(timeoutMs, 300_000)) : DEFAULT_FORWARD_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const request = await db.query.agentForwardedRequests.findFirst({ where: eq(agentForwardedRequests.id, id) });
    if (request?.status === "completed" && request.responseStatus !== null) {
      return new Response(request.responseBody === null ? null : Buffer.from(request.responseBody, "base64"), {
        status: request.responseStatus,
        headers: responseHeaders(request.responseHeaders),
      });
    }
    if (request?.status === "errored") throw new Error(request.errorMessage ?? "Agent request forwarding failed");
    await Bun.sleep(100);
  }
  await db.update(agentForwardedRequests).set({
    status: "errored",
    errorMessage: "Forwarded request timed out",
    completedAt: Date.now(),
  }).where(and(
    eq(agentForwardedRequests.id, id),
    inArray(agentForwardedRequests.status, ["queued", "claimed"]),
  ));
  throw new Error("Forwarded request timed out");
}
