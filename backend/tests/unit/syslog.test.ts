import { afterEach, describe, expect, it } from "bun:test";
import {
  formatSyslogMessage,
  pri,
  resolveHostname,
  resolveSyslogFormat,
  severityForLevel,
  type SyslogEntryInput,
} from "../../src/lib/syslog-format";
import { parseSyslogTarget, parseSyslogTargets } from "../../src/lib/syslog-transport";

const IDENTITY = { hostname: "terrence-host", appName: "terrence", procId: "4242" };

/** Explicit opt-in to the JSON message body; the default stays RFC 5424. */
const JSON_OPTS = { format: "json" } as const;

describe("syslog target parsing", (): void => {
  it("parses udp and tcp targets", (): void => {
    expect(parseSyslogTarget("udp://collector.example.com:514")).toEqual({
      transport: "udp",
      host: "collector.example.com",
      port: 514,
    });
    expect(parseSyslogTarget("tcp://10.0.0.1:601")).toEqual({
      transport: "tcp",
      host: "10.0.0.1",
      port: 601,
    });
  });

  it("parses bracketed IPv6 targets and rejects unsafe URL forms", (): void => {
    expect(parseSyslogTarget("udp://[2001:db8::10]:514")).toEqual({
      transport: "udp",
      host: "2001:db8::10",
      port: 514,
      family: 6,
    });
    expect(parseSyslogTarget("tcp://[::1]:601")).toEqual({
      transport: "tcp",
      host: "::1",
      port: 601,
      family: 6,
    });
    expect(parseSyslogTarget("udp://user:pass@[::1]:514")).toBeNull();
    expect(parseSyslogTarget("udp://[::1]:514/path")).toBeNull();
    expect(parseSyslogTarget("udp://[::1]:514?query")).toBeNull();
  });

  it("parses multiple targets while ignoring malformed entries", (): void => {
    expect(parseSyslogTargets("udp://one.example:514\ntcp://two.example:601,ftp://bad.example:514")).toEqual([
      { transport: "udp", host: "one.example", port: 514 },
      { transport: "tcp", host: "two.example", port: 601 },
    ]);
  });

  it("rejects malformed targets", (): void => {
    expect(parseSyslogTarget(undefined)).toBeNull();
    expect(parseSyslogTarget("")).toBeNull();
    expect(parseSyslogTarget("udp://host")).toBeNull();
    expect(parseSyslogTarget("smtp://host:25")).toBeNull();
    expect(parseSyslogTarget("tcp://host:0")).toBeNull();
    expect(parseSyslogTarget("tcp://host:99999")).toBeNull();
  });
});

describe("RFC 5424 formatting", (): void => {
  const base: SyslogEntryInput = {
    timestamp: "2026-08-26T03:00:00.000Z",
    level: "info",
    message: "request completed",
    meta: { requestId: "req-1", durationMs: 42 },
  };

  it("maps app levels onto syslog severities", (): void => {
    expect(severityForLevel("error")).toBe(3);
    expect(severityForLevel("warn")).toBe(4);
    expect(severityForLevel("info")).toBe(6);
    expect(severityForLevel("debug")).toBe(7);
    expect(severityForLevel("bogus")).toBe(6);
  });

  it("computes PRI as facility*8+severity", (): void => {
    expect(pri(1, 6)).toBe(14);
    expect(pri(1, 3)).toBe(11);
  });

  it("emits bare JSON with no syslog envelope for zero-config extraction", (): void => {
    const line = formatSyslogMessage(base, IDENTITY, JSON_OPTS);
    expect(line.startsWith("{")).toBeTrue();
    const body = JSON.parse(line) as Record<string, unknown>;
    expect(body).toEqual({
      timestamp: "2026-08-26T03:00:00.000Z",
      level: "info",
      message: "request completed",
      hostname: "terrence-host",
      app: "terrence",
      requestId: "req-1",
      durationMs: 42,
    });
  });

  it("keeps nested objects nested with numeric scalars for json extraction", (): void => {
    const line = formatSyslogMessage(
      {
        ...base,
        meta: {
          requestId: "req-1",
          http: { method: "GET", path: "/api/v2/organizations", status: 200, durationMs: 2 },
          outcome: "success",
        },
      },
      IDENTITY,
      JSON_OPTS,
    );
    const body = JSON.parse(line) as Record<string, unknown>;
    expect(body["http"]).toEqual({ method: "GET", path: "/api/v2/organizations", status: 200, durationMs: 2 });
    expect(body["outcome"]).toBe("success");
  });

  it("lets envelope fields win over colliding meta keys", (): void => {
    const line = formatSyslogMessage(
      { ...base, meta: { message: "evil", level: "evil", timestamp: "evil", hostname: "evil", app: "evil" } },
      IDENTITY,
      JSON_OPTS,
    );
    const body = JSON.parse(line) as Record<string, unknown>;
    expect(body["message"]).toBe("request completed");
    expect(body["level"]).toBe("info");
    expect(body["timestamp"]).toBe("2026-08-26T03:00:00.000Z");
    expect(body["hostname"]).toBe("terrence-host");
    expect(body["app"]).toBe("terrence");
  });

  it("serializes circular, Error, and bigint values without throwing", (): void => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const line = formatSyslogMessage(
      { ...base, meta: { circular, boom: new Error("kaput"), big: 10n } },
      IDENTITY,
      JSON_OPTS,
    );
    const body = JSON.parse(line) as Record<string, unknown>;
    expect(body["circular"]).toEqual({ name: "loop", self: "[Circular]" });
    expect(body["boom"]).toEqual({ name: "Error", message: "kaput" });
    expect(body["big"]).toBe("10");
  });

  it("preserves repeated references while still catching true cycles", (): void => {
    const shared: Record<string, unknown> = { tag: "same" };
    const line = formatSyslogMessage({ ...base, meta: { first: shared, second: shared } }, IDENTITY, JSON_OPTS);
    const body = JSON.parse(line) as Record<string, unknown>;
    expect(body["first"]).toEqual({ tag: "same" });
    expect(body["second"]).toEqual({ tag: "same" });
  });

  it("serializes Date values via toJSON instead of empty objects", (): void => {
    const line = formatSyslogMessage({ ...base, meta: { at: new Date("2026-01-02T03:04:05.000Z") } }, IDENTITY, JSON_OPTS);
    const body = JSON.parse(line) as Record<string, unknown>;
    expect(body["at"]).toBe("2026-01-02T03:04:05.000Z");
  });

  it("fits oversized bodies into the byte budget as valid JSON", (): void => {
    const line = formatSyslogMessage(
      { ...base, message: "m".repeat(2000), meta: { big: "x".repeat(2000) } },
      IDENTITY,
      { maxBodyBytes: 896, format: "json" },
    );
    const json = line;
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(896);
    const body = JSON.parse(json) as Record<string, unknown>;
    expect(body["truncated"]).toBe(true);
    expect(body["timestamp"]).toBe("2026-08-26T03:00:00.000Z");
    expect(typeof body["message"]).toBe("string");
    expect((body["message"] as string).startsWith("m")).toBeTrue();
  });

  it("defaults to RFC 5424 structured data and flattens nested meta", (): void => {
    const line = formatSyslogMessage(
      { ...base, meta: { requestId: "req-1", http: { method: "GET", status: 200 } } },
      IDENTITY,
    );
    expect(line).toContain('[terrence@65024 requestId="req-1" http.method="GET" http.status="200"]');
    expect(line.endsWith(" request completed")).toBeTrue();
  });

  it("resolves the syslog format defensively", (): void => {
    expect(resolveSyslogFormat("json")).toBe("json");
    expect(resolveSyslogFormat(" JSON ")).toBe("json");
    expect(resolveSyslogFormat("rfc5424")).toBe("rfc5424");
    expect(resolveSyslogFormat(undefined)).toBe("rfc5424");
    expect(resolveSyslogFormat("bogus")).toBe("rfc5424");
  });

  it("falls back to a NIL timestamp for malformed stamps", (): void => {
    const line = formatSyslogMessage({ ...base, timestamp: "yesterday" }, IDENTITY, JSON_OPTS);
    const body = JSON.parse(line) as Record<string, unknown>;
    expect(body["timestamp"]).toBe("-");
  });
});

describe("hostname resolution", (): void => {
  afterEach((): void => {
    delete process.env.TERRENCE_SYSLOG_HOSTNAME;
  });

  it("prefers the explicit override", (): void => {
    process.env.TERRENCE_SYSLOG_HOSTNAME = "explicit-host";
    expect(resolveHostname()).toBe("explicit-host");
  });

  it("falls back to /etc/hostname or a deterministic stable value", (): void => {
    delete process.env.TERRENCE_SYSLOG_HOSTNAME;
    const first = resolveHostname({ STORAGE_DIR: "/data" });
    const second = resolveHostname({ STORAGE_DIR: "/data" });
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(0);
    expect(first).not.toContain("\n");
  });
});
