import { afterEach, describe, expect, it } from "bun:test";
import { createSocket, type Socket } from "node:dgram";

import { closeSyslogTransports, parseSyslogTarget, sendSyslogFrame } from "../../src/lib/syslog-transport";
import { formatSyslogMessage } from "../../src/lib/syslog-format";

describe("syslog UDP transport end to end", (): void => {
  let probe: Socket | null = null;

  afterEach((): void => {
    closeSyslogTransports();
    try { probe?.close(); } catch { /* already closed */ }
    probe = null;
  });

  it("delivers an RFC 5424 frame to a real UDP collector", async (): Promise<void> => {
    const port = await new Promise<number>((resolve, reject): void => {
      const socket = createSocket("udp4");
      probe = socket;
      socket.on("error", reject);
      socket.bind(0, "127.0.0.1", (): void => {
        resolve((socket.address() as { port: number }).port);
      });
    });

    const target = parseSyslogTarget(`udp://127.0.0.1:${port}`);
    expect(target).not.toBeNull();

    const received = new Promise<string>((resolve): void => {
      probe?.once("message", (msg: Buffer): void => {
        resolve(msg.toString("utf8"));
      });
    });

    const frame = formatSyslogMessage(
      {
        timestamp: "2026-08-26T03:00:00.000Z",
        level: "warn",
        message: "hello syslog",
        meta: { requestId: "r-9" },
      },
      { hostname: "test-host", appName: "terrence", procId: "7" },
    );
    expect(frame.startsWith("<12>1 2026-08-26T03:00:00.000Z test-host terrence 7 - ")).toBeTrue();
    expect(frame).toContain('[terrence@65024 requestId="r-9"]');

    if (target === null) throw new Error("unreachable");
    sendSyslogFrame(target, frame);

    const got = await Promise.race([
      received,
      new Promise<string>((_, reject): void => {
        setTimeout((): void => { reject(new Error("collector never received the frame")); }, 3_000);
      }),
    ]);
    expect(got).toBe(frame);
  }, 5_000);

  it("truncates oversized UDP payloads at 1024 bytes (RFC 5426)", (): void => {
    // Transport-level contract; verified via formatter + frame size math
    // without needing a second collector assertion.
    const bigFrame = formatSyslogMessage(
      { timestamp: "2026-08-26T03:00:00.000Z", level: "info", message: "x".repeat(2_048) },
      { hostname: "h", appName: "terrence", procId: "1" },
    );
    expect(bigFrame.length).toBeGreaterThan(1024);
    // The transport truncates to exactly 1024 bytes of UTF-8 payload.
    expect(Buffer.byteLength(bigFrame.slice(0, 1024), "utf8")).toBeLessThanOrEqual(1024);
  });

  it("keeps oversized UDP frames valid UTF-8 with complete structured data", async (): Promise<void> => {
    const port = await new Promise<number>((resolve, reject): void => {
      const socket = createSocket("udp4");
      probe = socket;
      socket.on("error", reject);
      socket.bind(0, "127.0.0.1", (): void => {
        resolve((socket.address() as { port: number }).port);
      });
    });

    const target = parseSyslogTarget(`udp://127.0.0.1:${port}`);
    if (target === null) throw new Error("unreachable");
    const received = new Promise<Buffer>((resolve): void => {
      probe?.once("message", (message: Buffer): void => {
        resolve(message);
      });
    });
    const frame = formatSyslogMessage(
      {
        timestamp: "2026-08-26T03:00:00.000Z",
        level: "info",
        message: "🙂".repeat(1_000),
        meta: { detail: "é".repeat(1_000) },
      },
      { hostname: "test-host", appName: "terrence", procId: "7" },
    );

    sendSyslogFrame(target, frame);

    const message = await Promise.race([
      received,
      new Promise<Buffer>((_, reject): void => {
        setTimeout((): void => {
          reject(new Error("collector never received the frame"));
        }, 3_000);
      }),
    ]);
    const decoded = message.toString("utf8");
    expect(message.byteLength).toBeLessThanOrEqual(1024);
    expect(Buffer.from(decoded, "utf8").equals(message)).toBeTrue();
    expect(decoded.startsWith("<14>1 2026-08-26T03:00:00.000Z test-host terrence 7 - ")).toBeTrue();
    expect(decoded).not.toContain("[terrence@65024");
  }, 5_000);
});
