import { createSocket, type Socket } from "node:dgram";
import { connect, type Socket as TcpSocket } from "node:net";

// RFC 5424 syslog transport (kanban: configurable remote log shipping).
//
// Supports UDP (RFC 5426) and TCP (RFC 6587 octet-counted framing). The
// socket layer is deliberately minimal and failure-isolated: syslog is a
// best-effort diagnostic sink, so any transport error is swallowed after
// logging to the local console — a dead collector must never take down
// the API server.

export type SyslogTransport = "udp" | "tcp";

export type SyslogTarget = Readonly<{
  transport: SyslogTransport;
  host: string;
  port: number;
  family?: 4 | 6;
}>;

const MAX_UDP_PAYLOAD_BYTES = 1024;
type SyslogUrlFields = Readonly<Pick<URL, "username" | "password" | "pathname" | "search" | "hash" | "port">>;

function isValidSyslogUrl(url: SyslogUrlFields): boolean {
  return (
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.port !== ""
  );
}

/** Parse TERRENCE_SYSLOG_TARGET ("udp://host:514", "tcp://host:514"). */
export function parseSyslogTarget(raw: string | undefined): SyslogTarget | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  const schemeMatch = /^(udp|tcp):\/\//.exec(value);
  if (schemeMatch === null || schemeMatch[1] === undefined) return null;
  let url: URL;
  try {
    url = new URL(`http://${value.slice(schemeMatch[0].length)}`);
  } catch {
    return null;
  }
  if (!isValidSyslogUrl(url)) return null;
  const isIpv6 = url.hostname.startsWith("[") && url.hostname.endsWith("]");
  const host = isIpv6 ? url.hostname.slice(1, -1) : url.hostname;
  if (!isIpv6 && !/^[A-Za-z0-9._-]+$/.test(host)) return null;
  const port = Number.parseInt(url.port, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65_535) return null;
  return {
    transport: schemeMatch[1] as SyslogTransport,
    host,
    port,
    ...(isIpv6 ? { family: 6 as const } : {}),
  };
}

/** Parse one or more comma/newline-separated syslog targets. Invalid entries
 * are omitted so one stale destination cannot disable valid destinations. */
export function parseSyslogTargets(raw: string | undefined): SyslogTarget[] {
  return (raw?.split(/[\n,]+/u) ?? [])
    .map((value): SyslogTarget | null => parseSyslogTarget(value))
    .filter((target): target is SyslogTarget => target !== null);
}

const udpSockets = new Map<4 | 6, Socket>();

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
    result += character;
  }
  return result;
}

function structuredDataEnd(value: string): number | null {
  if (value.startsWith("- ")) return 1;
  if (!value.startsWith("[")) return null;
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
    } else if (value[index] === "]" && value[index + 1] === " ") {
      return index;
    }
  }
  return null;
}

/** Suffix that closes a structurally truncated JSON object body while
 * flagging the cut for collectors. */
const JSON_TRUNCATION_SUFFIX = '"truncated":true}';

/** Shorten a JSON object message to maxBytes while keeping it parseable:
 * cut after the last depth-1 boundary (`{` or `,`) that fits with the
 * truncation suffix. Falls back to a bare flagged object, then `{}`. */
function truncateJsonMessage(message: string, maxBytes: number): string {
  const fallback = `{"truncated":true}`;
  if (Buffer.byteLength(fallback, "utf8") > maxBytes) return "{}";
  if (message.trimStart().startsWith("{") === false) return fallback;
  const boundaries: number[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < message.length; index += 1) {
    const ch = message[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{" || ch === "[") {
      depth += 1;
      if (depth === 1) boundaries.push(index + 1);
    } else if (ch === "}" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 1) boundaries.push(index + 1);
  }
  let lo = 0;
  let hi = boundaries.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${message.slice(0, boundaries[mid - 1] as number)}${JSON_TRUNCATION_SUFFIX}`;
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) return fallback;
  return `${message.slice(0, boundaries[lo - 1] as number)}${JSON_TRUNCATION_SUFFIX}`;
}

function truncateSyslogFrame(frame: string, jsonBody: boolean): Buffer {
  const headerMatch = /^<\d+>1 \S+ \S+ \S+ \S+ \S+ /.exec(frame);
  if (headerMatch === null) return Buffer.from(truncateUtf8(frame, MAX_UDP_PAYLOAD_BYTES), "utf8");
  const header = headerMatch[0];
  const remainder = frame.slice(header.length);
  const structuredDataEndIndex = structuredDataEnd(remainder);
  const prefix =
    structuredDataEndIndex === null
      ? `${header}- `
      : `${header}${
          structuredDataEndIndex === 1 ? "-" : remainder.slice(0, structuredDataEndIndex + 1)
        } `;
  const messageStart =
    structuredDataEndIndex === null || structuredDataEndIndex === 1
      ? 2
      : structuredDataEndIndex + 2;
  const message = remainder.slice(messageStart);
  const safePrefix =
    structuredDataEndIndex !== null && Buffer.byteLength(prefix, "utf8") >= MAX_UDP_PAYLOAD_BYTES
      ? `${header}- `
      : prefix;
  const prefixBytes = Buffer.byteLength(safePrefix, "utf8");
  if (prefixBytes >= MAX_UDP_PAYLOAD_BYTES) {
    return Buffer.from(truncateUtf8(safePrefix, MAX_UDP_PAYLOAD_BYTES), "utf8");
  }
  if (jsonBody) {
    return Buffer.from(
      safePrefix + truncateJsonMessage(message, MAX_UDP_PAYLOAD_BYTES - prefixBytes),
      "utf8",
    );
  }
  return Buffer.from(
    truncateUtf8(safePrefix + message, MAX_UDP_PAYLOAD_BYTES),
    "utf8",
  );
}

function getUdpSocket(family: 4 | 6): Socket {
  let socket = udpSockets.get(family);
  if (socket !== undefined) return socket;
  socket = createSocket(family === 6 ? "udp6" : "udp4");
  socket.on("error", () => {
    /* ICMP unreachable etc. — syslog is fire-and-forget; keep the socket. */
  });
  udpSockets.set(family, socket);
  return socket;
}

const tcpSockets = new Map<string, TcpSocket>();

/** Send one already-framed datagram/segment. Never throws. */
export function sendSyslogFrame(
  target: SyslogTarget,
  frame: string,
  options?: Readonly<{ jsonBody?: boolean }>,
): void {
  const payload = Buffer.from(frame, "utf8");
  try {
    if (target.transport === "udp") {
      // RFC 5426: one syslog message per datagram; keep the frame valid while
      // truncating at 1024 bytes (the minimum every receiver must accept).
      // JSON bodies are repaired to parseable objects, not cut mid-value.
      const datagram =
        payload.length > MAX_UDP_PAYLOAD_BYTES
          ? truncateSyslogFrame(frame, options?.jsonBody === true)
          : payload;
      getUdpSocket(target.family ?? 4).send(datagram, target.port, target.host);
    } else {
      // RFC 6587 octet counting: "LEN MSG" so messages with newlines
      // reassemble unambiguously on the collector.
      const key = `${target.transport}:${target.family ?? 4}:${target.host}:${target.port}`;
      let socket: TcpSocket | undefined = tcpSockets.get(key);
      if (socket === undefined || socket.destroyed) {
        socket = connect({ host: target.host, port: target.port });
        socket.setNoDelay(true);
        socket.on("error", () => {
          /* connection refused/reset: drop this message, retry next time */
          if (tcpSockets.get(key) === socket) tcpSockets.delete(key);
        });
        tcpSockets.set(key, socket);
      }
      if (socket.writable) {
        socket.write(`${Buffer.byteLength(payload, "utf8")} `);
        socket.write(payload);
      }
    }
  } catch {
    // Best-effort by contract.
  }
}

/** Close transports cleanly (used by graceful shutdown and tests). */
export function closeSyslogTransports(): void {
  try {
    for (const socket of udpSockets.values()) {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
  } finally {
    udpSockets.clear();
  }
  for (const [, socket] of tcpSockets) {
    try {
      socket.end();
    } catch {
      /* already gone */
    }
  }
  tcpSockets.clear();
}
