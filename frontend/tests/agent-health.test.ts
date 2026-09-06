import { describe, expect, it } from "bun:test";

import {
  agentCapabilities,
  agentHealthState,
  formatLastObserved,
  summarizeAgentHealth,
  type AgentHealthRecord,
} from "../src/lib/agent-health";

function agent(
  id: string,
  status: string,
  lastPing: string | null,
  binaries: readonly string[] = ["terraform"],
): AgentHealthRecord {
  return {
    id,
    attributes: {
      name: id,
      status,
      "last-ping-at": lastPing,
      "iac-binaries": binaries,
    },
  };
}

describe("agent health presentation", (): void => {
  it("uses server status and heartbeat presence to classify usable workers", (): void => {
    expect(agentHealthState(agent("idle", "idle", "2026-09-06T12:00:00.000Z"))).toBe("idle");
    expect(agentHealthState(agent("busy", "busy", "2026-09-06T12:00:00.000Z"))).toBe("busy");
    expect(agentHealthState(agent("draining", "draining", "2026-09-06T12:00:00.000Z"))).toBe("draining");
    expect(agentHealthState(agent("unknown", "unknown", "2026-09-06T12:00:00.000Z"))).toBe("stale");
    expect(agentHealthState(agent("missing", "idle", null))).toBe("stale");
    expect(agentHealthState(agent("offline", "exited", "2026-09-06T12:00:00.000Z"))).toBe("offline");
    expect(agentHealthState(agent("offline-without-ping", "errored", null))).toBe("offline");
  });

  it("summarizes capacity without counting draining or stale workers as usable", (): void => {
    const summary = summarizeAgentHealth([
      agent("idle", "idle", "2026-09-06T12:00:00.000Z"),
      agent("busy", "busy", "2026-09-06T12:00:00.000Z"),
      agent("draining", "draining", "2026-09-06T12:00:00.000Z"),
      agent("stale", "unknown", "2026-09-06T12:00:00.000Z"),
      agent("offline", "exited", "2026-09-06T12:00:00.000Z"),
    ]);

    expect(summary).toEqual({ total: 5, usable: 2, idle: 1, busy: 1, draining: 1, stale: 1, failed: 1 });
  });

  it("preserves last-observed wording and declared execution capabilities", (): void => {
    const now = Date.parse("2026-09-06T12:00:00.000Z");
    expect(formatLastObserved("2026-09-06T11:58:00.000Z", now)).toBe("Observed 2m ago");
    expect(formatLastObserved(null, now)).toBe("Never observed");
    expect(formatLastObserved("not-a-date", now)).toBe("Invalid timestamp");
    expect(agentCapabilities(agent("tofu", "idle", "2026-09-06T12:00:00.000Z", ["tofu", "terraform"]))).toEqual(["tofu", "terraform"]);
    expect(agentCapabilities(agent("legacy", "idle", "2026-09-06T12:00:00.000Z", []))).toEqual(["terraform"]);
  });
});
