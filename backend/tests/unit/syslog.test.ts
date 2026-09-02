import { afterEach, describe, expect, it } from "bun:test";
import {
  formatSyslogMessage,
  pri,
  resolveHostname,
  severityForLevel,
  type SyslogEntryInput,
} from "../../src/lib/syslog-format";
import { parseSyslogTarget, parseSyslogTargets } from "../../src/lib/syslog-transport";

const IDENTITY = { hostname: "terrence-host", appName: "terrence", procId: "4242" };

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

  it("emits a spec-shaped message with structured data", (): void => {
    const line = formatSyslogMessage(base, IDENTITY);
    expect(line.startsWith("<14>1 2026-08-26T03:00:00.000Z terrence-host terrence 4242 - ")).toBeTrue();
    // SD-ELEMENT with private enterprise id and escaped params
    expect(line).toContain('[terrence@65024 requestId="req-1" durationMs="42"]');
    // Message body last
    expect(line.endsWith(" request completed")).toBeTrue();
  });

  it("uses the NIL value for empty structured data", (): void => {
    const { meta: _omitted, ...withoutMeta } = base;
    void _omitted;
    const line = formatSyslogMessage(withoutMeta, IDENTITY);
    expect(line).toContain(" - - request completed");
    expect(line).not.toContain("[terrence@");
  });

  it("escapes backslashes, brackets, and control characters in param values", (): void => {
    const line = formatSyslogMessage(
      { ...base, meta: { detail: 'a\\b]c\nd' } },
      IDENTITY,
    );
    expect(line).toContain('detail="a\\\\b\\]cd"');
  });

  it("stringifies scalar meta values and flattens nested objects into dotted params", (): void => {
    const line = formatSyslogMessage({ ...base, meta: { count: 3, nested: { ok: true } } }, IDENTITY);
    expect(line).toContain('count="3"');
    expect(line).toContain('nested.ok="true"');
    expect(line).not.toContain("nested=");
  });

  it("flattens request-shaped meta so collectors can index http fields", (): void => {
    const line = formatSyslogMessage(
      {
        ...base,
        meta: {
          requestId: "req-1",
          http: { method: "GET", path: "/api/v2/organizations", status: 200, durationMs: 2 },
          routeBucket: "GET /api/v2/organizations",
          outcome: "success",
        },
      },
      IDENTITY,
    );
    expect(line).toContain('http.method="GET"');
    expect(line).toContain('http.path="/api/v2/organizations"');
    expect(line).toContain('http.status="200"');
    expect(line).toContain('http.durationMs="2"');
    expect(line).not.toContain("http=");
  });

  it("indexes arrays and drops nullish values", (): void => {
    const line = formatSyslogMessage(
      { ...base, meta: { tags: ["a", "b"], missing: null, absent: undefined, kept: "yes" } },
      IDENTITY,
    );
    expect(line).toContain('tags.0="a"');
    expect(line).toContain('tags.1="b"');
    expect(line).toContain('kept="yes"');
    expect(line).not.toContain("missing=");
    expect(line).not.toContain("absent=");
  });

  it("never throws on circular or over-deep meta", (): void => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 10; i += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const line = formatSyslogMessage({ ...base, meta: { circular, deep } }, IDENTITY);
    expect(line).toContain("circular.name=");
    expect(line).toContain("circular.self=");
    expect(line).toContain("deep.next");
    expect(line.endsWith(" request completed")).toBeTrue();
  });

  it("falls back to a NIL timestamp for malformed stamps", (): void => {
    const line = formatSyslogMessage({ ...base, timestamp: "yesterday" }, IDENTITY);
    expect(line.startsWith("<14>1 - ")).toBeTrue();
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
