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
}>;

const MAX_UDP_PAYLOAD_BYTES = 1024;

/** Parse TERRENCE_SYSLOG_TARGET ("udp://host:514", "tcp://host:514"). */
export function parseSyslogTarget(raw: string | undefined): SyslogTarget | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  const match = /^(udp|tcp):\/\/([A-Za-z0-9._-]+):(\d{1,5})$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return null;
  }
  const port = Number.parseInt(match[3], 10);
  if (!Number.isFinite(port) || port < 1 || port > 65_535) return null;
  return { transport: match[1] as SyslogTransport, host: match[2], port };
}

let udpSocket: Socket | null = null;

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

function truncateSyslogFrame(frame: string): Buffer {
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
  const messageStart = structuredDataEndIndex === null ? 2 : structuredDataEndIndex + 2;
  const message = remainder.slice(messageStart);
  const safePrefix =
    structuredDataEndIndex !== null && Buffer.byteLength(prefix, "utf8") >= MAX_UDP_PAYLOAD_BYTES
      ? `${header}- `
      : prefix;
  const prefixBytes = Buffer.byteLength(safePrefix, "utf8");
  if (prefixBytes >= MAX_UDP_PAYLOAD_BYTES) {
    return Buffer.from(truncateUtf8(safePrefix, MAX_UDP_PAYLOAD_BYTES), "utf8");
  }
  return Buffer.from(
    truncateUtf8(safePrefix + message, MAX_UDP_PAYLOAD_BYTES),
    "utf8",
  );
}

function getUdpSocket(): Socket {
  udpSocket ??= createSocket("udp4");
  udpSocket.on("error", () => {
    /* ICMP unreachable etc. — syslog is fire-and-forget; keep the socket. */
  });
  return udpSocket;
}

const tcpSockets = new Map<string, TcpSocket>();

/** Send one already-framed datagram/segment. Never throws. */
export function sendSyslogFrame(target: SyslogTarget, frame: string): void {
  const payload = Buffer.from(frame, "utf8");
  try {
    if (target.transport === "udp") {
      // RFC 5426: one syslog message per datagram; keep the frame valid while
      // truncating at 1024 bytes (the minimum every receiver must accept).
      const datagram =
        payload.length > MAX_UDP_PAYLOAD_BYTES ? truncateSyslogFrame(frame) : payload;
      getUdpSocket().send(datagram, target.port, target.host);
    } else {
      // RFC 6587 octet counting: "LEN MSG" so messages with newlines
      // reassemble unambiguously on the collector.
      const key = `${target.host}:${target.port}`;
      let socket: TcpSocket | undefined = tcpSockets.get(key);
      if (socket === undefined || socket.destroyed) {
        socket = connect({ host: target.host, port: target.port });
        socket.setNoDelay(true);
        socket.on("error", () => {
          /* connection refused/reset: drop this message, retry next time */
          tcpSockets.delete(key);
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
    udpSocket?.close();
  } catch {
    /* already closed */
  }
  udpSocket = null;
  for (const [, socket] of tcpSockets) {
    try {
      socket.end();
    } catch {
      /* already gone */
    }
  }
  tcpSockets.clear();
}
