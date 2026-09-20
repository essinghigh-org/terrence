/** Mixed-version compatibility for rolling HA upgrades.
 *
 * Application versions enforce the supported release skew. Protocol versions
 * cover cross-replica semantics and are checked in both directions:
 *
 *   compatible(a, b) <=> a.protocol >= b.minProtocol && b.protocol >= a.minProtocol
 */

/**
 * Current HA protocol version.
 *
 * Bump this whenever a release changes cross-replica semantics: lease table
 * columns or predicates, fencing token/epoch meaning, `control_events` topics
 * or payload shapes, node registry fields another replica reads, durable-job
 * payload shapes, or any enum-like status value a peer must recognise.
 */
export const HA_PROTOCOL_VERSION = 2;

/**
 * Oldest protocol this release will serve alongside.
 *
 * The supported rolling-upgrade window is one protocol version (N <-> N-1).
 * When `HA_PROTOCOL_VERSION` becomes 2 this becomes 1; when it becomes 3 this
 * becomes 2, which is what retires protocol 1 from the window.
 */
export const HA_MIN_COMPATIBLE_PROTOCOL_VERSION = 1;

/** A live peer as advertised through `control_plane_nodes`. */
export type ClusterPeer = Readonly<{
  nodeId: string;
  applicationVersion: string | null;
  protocolVersion: number | null;
  minProtocolVersion: number | null;
}>;

export type LocalProtocolIdentity = Readonly<{
  nodeId: string;
  applicationVersion: string;
  protocolVersion: number;
  minProtocolVersion: number;
}>;

export type PeerIncompatibility = Readonly<{
  nodeId: string;
  applicationVersion: string | null;
  protocolVersion: number | null;
  reason: string;
}>;

export type ClusterCompatibility = Readonly<{
  compatible: boolean;
  /** Lowest protocol version observed among live peers, local node included. */
  oldestPeerProtocolVersion: number;
  incompatiblePeers: readonly PeerIncompatibility[];
  summary: string;
}>;

export function localProtocolIdentity(nodeId: string, applicationVersion: string): LocalProtocolIdentity {
  return {
    nodeId,
    applicationVersion,
    protocolVersion: HA_PROTOCOL_VERSION,
    minProtocolVersion: HA_MIN_COMPATIBLE_PROTOCOL_VERSION,
  };
}

export type ReleaseVersion = Readonly<{ major: number; minor: number; patch: number }>;

/** Parse a released semantic version. Development/non-release identities return null and use protocol-only compatibility. */
export function parseReleaseVersion(value: string | null | undefined): ReleaseVersion | null {
  if (typeof value !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (match === null) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return { major, minor, patch };
}

/** Same major and at most one minor apart. Development builds skip this
 * release-number check and remain governed by the HA protocol window. */
export function withinRollingReleaseWindow(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (a === null || b === null) return true;
  if (a.major !== b.major) return false;
  return Math.abs(a.minor - b.minor) <= 1;
}

/** Rows written before HA protocol metadata existed are protocol 1. */
function peerProtocol(peer: ClusterPeer): { protocol: number; min: number } {
  return {
    protocol: peer.protocolVersion ?? 1,
    min: peer.minProtocolVersion ?? 1,
  };
}

/** Evaluate this node against the supplied fresh peer rows. */
export function evaluateClusterCompatibility(
  local: LocalProtocolIdentity,
  peers: readonly ClusterPeer[],
): ClusterCompatibility {
  const incompatiblePeers: PeerIncompatibility[] = [];
  let oldest = local.protocolVersion;

  for (const peer of peers) {
    const { protocol, min } = peerProtocol(peer);
    oldest = Math.min(oldest, protocol);

    if (protocol < local.minProtocolVersion) {
      incompatiblePeers.push({
        nodeId: peer.nodeId,
        applicationVersion: peer.applicationVersion,
        protocolVersion: protocol,
        reason:
          `peer speaks HA protocol ${String(protocol)} but this release requires at least ` +
          String(local.minProtocolVersion),
      });
      continue;
    }
    if (local.protocolVersion < min) {
      incompatiblePeers.push({
        nodeId: peer.nodeId,
        applicationVersion: peer.applicationVersion,
        protocolVersion: protocol,
        reason:
          `peer requires at least HA protocol ${String(min)} but this release speaks ` + String(local.protocolVersion),
      });
      continue;
    }
    if (!withinRollingReleaseWindow(local.applicationVersion, peer.applicationVersion)) {
      incompatiblePeers.push({
        nodeId: peer.nodeId,
        applicationVersion: peer.applicationVersion,
        protocolVersion: protocol,
        reason:
          `application version ${peer.applicationVersion ?? "unknown"} is outside the supported N/N-1 window for ` +
          local.applicationVersion,
      });
    }
  }

  if (incompatiblePeers.length > 0) {
    const detail = incompatiblePeers
      .map((peer): string => `${peer.nodeId}: ${peer.reason}`)
      .sort((left, right): number => left.localeCompare(right))
      .join("; ");
    return {
      compatible: false,
      oldestPeerProtocolVersion: oldest,
      incompatiblePeers,
      summary: `HA protocol ${String(local.protocolVersion)} cannot join the live cluster: ${detail}`,
    };
  }

  return {
    compatible: true,
    oldestPeerProtocolVersion: oldest,
    incompatiblePeers: [],
    summary: `HA protocol ${String(local.protocolVersion)} is compatible with ${String(peers.length)} live peer(s)`,
  };
}

export class ClusterProtocolIncompatibleError extends Error {
  public readonly incompatiblePeers: readonly PeerIncompatibility[];

  constructor(compatibility: Readonly<ClusterCompatibility>) {
    super(compatibility.summary);
    this.name = "ClusterProtocolIncompatibleError";
    this.incompatiblePeers = compatibility.incompatiblePeers;
  }
}
