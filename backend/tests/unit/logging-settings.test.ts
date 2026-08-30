import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createSocket, type Socket } from "node:dgram";
import { applyLoggingSettings, log } from "../../src/lib/log";

const originalSyslogTarget = process.env.TERRENCE_SYSLOG_TARGET;
const originalSyslogTargets = process.env.TERRENCE_SYSLOG_TARGETS;

type UdpCollector = Readonly<{
  socket: Socket;
  port: number;
  received: string[];
}>;

async function openCollector(): Promise<UdpCollector> {
  return new Promise<UdpCollector>((resolve, reject): void => {
    const socket = createSocket("udp4");
    const received: string[] = [];
    socket.on("message", (message: Buffer): void => {
      received.push(message.toString("utf8"));
    });
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", (): void => {
      socket.removeListener("error", reject);
      resolve({ socket, port: (socket.address() as { port: number }).port, received });
    });
  });
}

afterEach((): void => {
  applyLoggingSettings({ enabled: false, "syslog-targets": [] });
  if (originalSyslogTarget === undefined) delete process.env.TERRENCE_SYSLOG_TARGET;
  else process.env.TERRENCE_SYSLOG_TARGET = originalSyslogTarget;
  if (originalSyslogTargets === undefined) delete process.env.TERRENCE_SYSLOG_TARGETS;
  else process.env.TERRENCE_SYSLOG_TARGETS = originalSyslogTargets;
});

describe("runtime logging configuration", () => {
  it("changes the active local level without reloading the process", () => {
    const logSpy = spyOn(console, "log").mockImplementation((): void => {
      /* suppress test output */
    });
    try {
      applyLoggingSettings({ "log-level": "error", "syslog-targets": [] });
      log.info("hidden at error level");
      expect(logSpy).not.toHaveBeenCalled();

      applyLoggingSettings({ "log-level": "debug", "syslog-targets": [] });
      log.info("visible after hot reload");
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("honors enabled and remote-level changes in the running process", async () => {
    const collector = await openCollector();
    const logSpy = spyOn(console, "log").mockImplementation((): void => {
      /* suppress test output */
    });
    const warnSpy = spyOn(console, "warn").mockImplementation((): void => {
      /* suppress test output */
    });
    try {
      process.env.TERRENCE_SYSLOG_TARGET = `udp://127.0.0.1:${String(collector.port)}`;
      applyLoggingSettings({ enabled: false, "syslog-targets": null, "syslog-level": "debug" });
      log.error("disabled remote message");
      await Bun.sleep(25);
      expect(collector.received).toHaveLength(0);

      applyLoggingSettings({
        enabled: true,
        "log-level": "debug",
        "syslog-level": "warn",
        "syslog-targets": [`udp://127.0.0.1:${String(collector.port)}`],
        "syslog-hostname": "test-host",
        "syslog-app": "terrence-test",
      });
      log.info("filtered remote message");
      log.warn("forwarded remote message");
      await Bun.sleep(25);
      expect(collector.received).toHaveLength(1);
      expect(collector.received[0]).toContain("forwarded remote message");
      expect(collector.received[0]).not.toContain("filtered remote message");
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      collector.socket.close();
    }
  });
});
