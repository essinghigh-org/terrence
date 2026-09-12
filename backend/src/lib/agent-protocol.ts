/**
 * Terrence agent protocol compatibility contract.
 *
 * The agent software version (for example, tfc-agent 1.30.1) is deliberately
 * separate from this protocol version.  A client may continue to use an old
 * agent binary while negotiating a compatible protocol, and a new binary may
 * advertise a future capability without making the whole registration
 * request fail.
 */

export const AGENT_PROTOCOL_PRODUCT = "terrence-agent";
export const AGENT_PROTOCOL_VERSION = "1";
export const AGENT_PROTOCOL_SUPPORTED_VERSIONS = [AGENT_PROTOCOL_VERSION] as const;

export const AGENT_PROTOCOL_CAPABILITIES = [
  "operation.plan",
  "operation.apply",
  "operation.policy",
  "operation.assessment",
  "operation.stack",
  "operation.source-bundle",
  "operation.test",
  "artifact.configuration",
  "artifact.filesystem",
  "artifact.log",
  "artifact.plan-json",
  "artifact.state-json",
  "artifact.atomic-upload",
  "lease.heartbeat",
  "lease.fencing",
  "cancellation",
  "state.publication",
] as const;

export type AgentProtocolCapability = (typeof AGENT_PROTOCOL_CAPABILITIES)[number];

/**
 * A legacy agent did not send protocol metadata.  It has the original
 * workspace execution contract, which includes all capabilities required by
 * the existing API.  This keeps old agents usable while making an explicit
 * capability offer authoritative for newer agents.
 */
export const LEGACY_AGENT_CAPABILITIES: readonly AgentProtocolCapability[] = [
  ...AGENT_PROTOCOL_CAPABILITIES,
];

export const AGENT_ARTIFACT_FORMATS = ["tar.gz", "json", "text"] as const;
export type AgentArtifactFormat = (typeof AGENT_ARTIFACT_FORMATS)[number];

export type AgentProtocolOffer = Readonly<{
  versions: readonly string[];
  capabilities: readonly string[];
  requiredCapabilities: readonly string[];
  artifactFormats: readonly string[];
  legacy: boolean;
}>;

export type AgentProtocolNegotiation = Readonly<{
  version: string;
  capabilities: readonly AgentProtocolCapability[];
  unsupportedCapabilities: readonly string[];
  artifactFormats: readonly AgentArtifactFormat[];
  unsupportedArtifactFormats: readonly string[];
  legacy: boolean;
}>;

export class AgentProtocolNegotiationError extends Error {
  public readonly status: 406 | 422;
  public readonly code: "unsupported-version" | "unsupported-capability";
  public readonly versions: readonly string[];
  public readonly capabilities: readonly string[];

  constructor(
    status: 406 | 422,
    code: "unsupported-version" | "unsupported-capability",
    message: string,
    details: { versions?: readonly string[]; capabilities?: readonly string[] } = {},
  ) {
    super(message);
    this.name = "AgentProtocolNegotiationError";
    this.status = status;
    this.code = code;
    this.versions = details.versions ?? [];
    this.capabilities = details.capabilities ?? [];
  }
}

const capabilitySet = new Set<string>(AGENT_PROTOCOL_CAPABILITIES);
const artifactFormatSet = new Set<string>(AGENT_ARTIFACT_FORMATS);

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 128)) {
    return undefined;
  }
  return [...new Set(value)];
}

function commaList(value: string | null): string[] | undefined {
  if (value === null || value.trim() === "") return undefined;
  const result = value.split(",").map((item): string => item.trim()).filter((item): boolean => item !== "");
  return result.length === 0 ? undefined : [...new Set(result)];
}

function versionList(value: unknown): string[] | undefined {
  if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  return stringList(value);
}

function offerVersions(body: Readonly<Record<string, unknown>>, headerVersion: string | null): string[] {
  return versionList(body["protocol_versions"])
    ?? versionList(body["protocol_version"])
    ?? commaList(headerVersion)
    ?? [];
}

function offerCapabilities(body: Readonly<Record<string, unknown>>, headerCapabilities: string | null): string[] | undefined {
  return stringList(body["capabilities"])
    ?? commaList(headerCapabilities);
}

function offerRequiredCapabilities(body: Readonly<Record<string, unknown>>, headerRequired: string | null): string[] {
  return stringList(body["required_capabilities"])
    ?? stringList(body["requiredCapabilities"])
    ?? commaList(headerRequired)
    ?? [];
}

function offerArtifactFormats(body: Readonly<Record<string, unknown>>, headerFormats: string | null): string[] {
  return stringList(body["artifact_formats"])
    ?? stringList(body["artifactFormats"])
    ?? commaList(headerFormats)
    ?? [];
}

/** Parse protocol metadata from the registration request. */
export function parseAgentProtocolOffer(
  body: Readonly<Record<string, unknown>>,
  headers: Readonly<{ get(name: string): string | null }>,
): AgentProtocolOffer {
  const headerVersion = headers.get("tfc-agent-protocol-version") ?? headers.get("terrence-agent-protocol-version");
  const headerCapabilities = headers.get("tfc-agent-capabilities") ?? headers.get("terrence-agent-capabilities");
  const headerRequired = headers.get("tfc-agent-required-capabilities") ?? headers.get("terrence-agent-required-capabilities");
  const headerFormats = headers.get("tfc-agent-artifact-formats") ?? headers.get("terrence-agent-artifact-formats");
  const versions = offerVersions(body, headerVersion);
  const rawCapabilities = offerCapabilities(body, headerCapabilities);
  const rawRequired = offerRequiredCapabilities(body, headerRequired);
  const artifactFormats = offerArtifactFormats(body, headerFormats);
  return {
    // An absent offer is the pre-versioning protocol and must remain usable.
    versions,
    capabilities: rawCapabilities ?? [...LEGACY_AGENT_CAPABILITIES],
    requiredCapabilities: rawRequired,
    artifactFormats,
    legacy: versions.length === 0 && rawCapabilities === undefined && rawRequired.length === 0,
  };
}

function compatibleVersion(value: string): boolean {
  const match = /^(\d+)(?:\.\d+)?$/.exec(value);
  return match !== null && match[1] === AGENT_PROTOCOL_VERSION;
}

/** Negotiate one protocol version and the known subset of client capabilities. */
export function negotiateAgentProtocol(offer: AgentProtocolOffer): AgentProtocolNegotiation {
  const versions = offer.versions.length === 0 ? [AGENT_PROTOCOL_VERSION] : offer.versions;
  const version = versions.find(compatibleVersion);
  if (version === undefined) {
    throw new AgentProtocolNegotiationError(
      406,
      "unsupported-version",
      `No compatible agent protocol version; supported versions: ${AGENT_PROTOCOL_SUPPORTED_VERSIONS.join(", ")}`,
      { versions },
    );
  }
  const unsupportedRequired = offer.requiredCapabilities.filter((capability): boolean => !capabilitySet.has(capability));
  if (unsupportedRequired.length > 0) {
    throw new AgentProtocolNegotiationError(
      422,
      "unsupported-capability",
      `Required agent capabilities are unsupported: ${unsupportedRequired.join(", ")}`,
      { capabilities: unsupportedRequired },
    );
  }
  return {
    version: AGENT_PROTOCOL_VERSION,
    capabilities: offer.capabilities.filter((capability): capability is AgentProtocolCapability => capabilitySet.has(capability)),
    unsupportedCapabilities: offer.capabilities.filter((capability): boolean => !capabilitySet.has(capability)),
    artifactFormats: (offer.artifactFormats.length === 0 ? [...AGENT_ARTIFACT_FORMATS] : offer.artifactFormats)
      .filter((format): format is AgentArtifactFormat => artifactFormatSet.has(format)),
    unsupportedArtifactFormats: offer.artifactFormats.filter((format): boolean => !artifactFormatSet.has(format)),
    legacy: offer.legacy,
  };
}

export function serializeAgentCapabilities(capabilities: readonly string[]): string {
  return [...new Set(capabilities)].sort((left, right): number => left.localeCompare(right)).join(",");
}

export function agentProtocolDescription(): Readonly<Record<string, unknown>> {
  return {
    product: AGENT_PROTOCOL_PRODUCT,
    protocol_version: AGENT_PROTOCOL_VERSION,
    supported_protocol_versions: [...AGENT_PROTOCOL_SUPPORTED_VERSIONS],
    capabilities: [...AGENT_PROTOCOL_CAPABILITIES],
    artifact_formats: [...AGENT_ARTIFACT_FORMATS],
    negotiation: {
      version_header: "Tfc-Agent-Protocol-Version",
      capabilities_header: "Tfc-Agent-Capabilities",
      required_capabilities_header: "Tfc-Agent-Required-Capabilities",
      optional_unknown_capabilities: true,
    },
  };
}

export function agentSupportsCapability(agent: Readonly<{ capabilities?: readonly string[] | null }>, capability: AgentProtocolCapability): boolean {
  const capabilities = agent.capabilities ?? LEGACY_AGENT_CAPABILITIES;
  return capabilities.includes(capability);
}

const PHASE_REQUIREMENTS: Readonly<Record<string, readonly AgentProtocolCapability[]>> = {
  plan: ["operation.plan", "artifact.configuration", "artifact.filesystem", "artifact.log", "artifact.plan-json", "lease.heartbeat", "lease.fencing"],
  apply: ["operation.apply", "artifact.configuration", "artifact.filesystem", "artifact.log", "artifact.state-json", "lease.heartbeat", "lease.fencing", "cancellation", "state.publication"],
  stack_prepare: ["operation.stack", "artifact.configuration", "lease.heartbeat", "lease.fencing"],
  stack_plan: ["operation.stack", "artifact.configuration", "lease.heartbeat", "lease.fencing"],
  stack_apply: ["operation.stack", "artifact.configuration", "artifact.state-json", "lease.heartbeat", "lease.fencing", "cancellation", "state.publication"],
};

export function agentSupportsPhase(
  agent: Readonly<{ capabilities?: readonly string[] | null; artifactFormats?: readonly string[] | null }>,
  phase: string,
): boolean {
  const requirements = PHASE_REQUIREMENTS[phase] ?? [];
  if (!requirements.every((capability): boolean => agentSupportsCapability(agent, capability))) return false;
  const formats = agent.artifactFormats ?? AGENT_ARTIFACT_FORMATS;
  if (phase === "plan" && !formats.includes("json")) return false;
  if (phase === "apply" && (!formats.includes("json") || !formats.includes("tar.gz"))) return false;
  if (phase === "stack_apply" && (!formats.includes("json") || !formats.includes("tar.gz"))) return false;
  return true;
}

export type AgentExecutionPolicy = Readonly<{
  protocolVersion: string;
  capabilities: readonly string[];
  operation: string;
  iacBinary: string;
  artifactFormats: readonly AgentArtifactFormat[];
  lease: Readonly<{ heartbeat: "status"; fencing: true }>;
  cancellation: "cooperative";
  statePublication: "finalize-once";
}>;

export function effectiveAgentExecutionPolicy(
  agent: Readonly<{ protocolVersion?: string | null; capabilities?: readonly string[] | null; artifactFormats?: readonly string[] | null }>,
  operation: string,
  iacBinary: string,
): AgentExecutionPolicy {
  return {
    protocolVersion: agent.protocolVersion ?? AGENT_PROTOCOL_VERSION,
    capabilities: [...(agent.capabilities ?? LEGACY_AGENT_CAPABILITIES)].sort((left, right): number => left.localeCompare(right)),
    operation,
    iacBinary,
    artifactFormats: (agent.artifactFormats ?? AGENT_ARTIFACT_FORMATS).filter((format): format is AgentArtifactFormat => artifactFormatSet.has(format)),
    lease: { heartbeat: "status", fencing: true },
    cancellation: "cooperative",
    statePublication: "finalize-once",
  };
}
