import { describe, expect, test } from "bun:test";
import {
  AGENT_PROTOCOL_VERSION,
  LEGACY_AGENT_CAPABILITIES,
  AgentProtocolNegotiationError,
  agentSupportsPhase,
  negotiateAgentProtocol,
  parseAgentProtocolOffer,
} from "../../src/lib/agent-protocol";

const headers = (values: Record<string, string>): { get(name: string): string | null } => ({
  get(name: string): string | null {
    return values[name.toLowerCase()] ?? null;
  },
});

describe("agent protocol compatibility contract", () => {
  test("keeps an old agent on the legacy v1 capability set", () => {
    const offer = parseAgentProtocolOffer({ name: "old-agent" }, headers({}));
    const negotiated = negotiateAgentProtocol(offer);
    expect(negotiated.version).toBe(AGENT_PROTOCOL_VERSION);
    expect(negotiated.legacy).toBe(true);
    expect(negotiated.capabilities).toEqual(LEGACY_AGENT_CAPABILITIES);
    expect(negotiated.unsupportedCapabilities).toEqual([]);
  });

  test("selects v1 from a multi-version offer and ignores an unknown future capability", () => {
    const offer = parseAgentProtocolOffer({
      protocol_versions: ["2", "1"],
      capabilities: ["operation.plan", "future.artifact.v2"],
    }, headers({}));
    const negotiated = negotiateAgentProtocol(offer);
    expect(negotiated.version).toBe("1");
    expect(negotiated.capabilities).toEqual(["operation.plan"]);
    expect(negotiated.unsupportedCapabilities).toEqual(["future.artifact.v2"]);
  });

  test("rejects an unknown required capability without changing the offer", () => {
    const offer = parseAgentProtocolOffer({
      protocol_version: "1",
      capabilities: ["operation.plan"],
      required_capabilities: ["future.artifact.v2"],
    }, headers({}));
    expect(() => negotiateAgentProtocol(offer)).toThrow(AgentProtocolNegotiationError);
    try {
      negotiateAgentProtocol(offer);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AgentProtocolNegotiationError);
      expect((error as AgentProtocolNegotiationError).status).toBe(422);
      expect((error as AgentProtocolNegotiationError).code).toBe("unsupported-capability");
      expect((error as AgentProtocolNegotiationError).capabilities).toEqual(["future.artifact.v2"]);
    }
  });

  test("rejects an old server-incompatible future-only version", () => {
    const offer = parseAgentProtocolOffer({ protocol_version: "2" }, headers({}));
    expect(() => negotiateAgentProtocol(offer)).toThrow(/No compatible agent protocol version/);
  });

  test("requires the negotiated lease and artifact contract before dispatch", () => {
    expect(agentSupportsPhase({ capabilities: ["operation.plan"] }, "plan")).toBe(false);
    expect(agentSupportsPhase({ capabilities: [...LEGACY_AGENT_CAPABILITIES] }, "plan")).toBe(true);
    expect(agentSupportsPhase({ capabilities: ["operation.apply", "artifact.configuration"] }, "apply")).toBe(false);
  });
});
