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

const udpSockets = new Map<4 | 6, Socket>();

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
export function sendSyslogFrame(target: SyslogTarget, frame: string): void {
  const payload = Buffer.from(frame, "utf8");
  try {
    if (target.transport === "udp") {
      // RFC 5426: one syslog message per datagram; truncate at 1024 bytes
      // (the minimum every receiver must accept) rather than fragmenting.
      const datagram = payload.length > 1024 ? payload.subarray(0, 1024) : payload;
      getUdpSocket(target.family ?? 4).send(datagram, target.port, target.host);
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
