/**
 * HA-3A: mixed-version compatibility for rolling upgrades.
 *
 * Phase 1 and 2 answer "what happens when a replica fails?". This module
 * answers the different question a deployment asks: "may these two binaries
 * serve the same database at the same time?".
 *
 * Two separate versions are tracked because they change at different rates:
 *
 *   application version  marketing/release identity (1.4.0, 1.5.1, ...)
 *   HA protocol version  distributed semantics (leases, fencing, control
 *                        events, node registry, durable-job payloads)
 *
 * Two application releases that do not change distributed semantics share one
 * protocol version and may coexist freely. A release that does change them
 * bumps `HA_PROTOCOL_VERSION`, and declares how far back it is still willing to
 * interoperate with `HA_MIN_COMPATIBLE_PROTOCOL_VERSION`.
 *
 * Compatibility is an intersection of two advertised windows rather than a
 * one-sided check, so both the joining node and the incumbent peers get a veto:
 *
 *   compatible(a, b) <=> a.protocol >= b.minProtocol && b.protocol >= a.minProtocol
 *
 * That is what makes `N <-> N-1` supportable without supporting arbitrary skew:
 * release N ships `min = N-1`, so N and N-1 intersect, while N and N-2 do not.
 */

/**
 * Current HA protocol version.
 *
 * Bump this whenever a release changes cross-replica semantics: lease table
 * columns or predicates, fencing token/epoch meaning, `control_events` topics
 * or payload shapes, node registry fields another replica reads, durable-job
 * payload shapes, or any enum-like status value a peer must recognise.
 */
export const HA_PROTOCOL_VERSION = 1;

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

/**
 * Parse a release identity. Development builds ("dev", a git SHA, a channel
 * suffix) deliberately return null: an unparseable version is not evidence of
 * incompatibility, and refusing to start a developer build against a released
 * peer would make local debugging of an HA cluster impossible. Protocol
 * versions, which every build does advertise, remain authoritative.
 */
export function parseReleaseVersion(value: string | null | undefined): ReleaseVersion | null {
  if (typeof value !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (match === null) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return { major, minor, patch };
}

/**
 * Advisory release-window check: same major, at most one minor apart. This is
 * reported for operator visibility but is not by itself a startup veto,
 * because the protocol version is the semantic contract. A release that
 * genuinely breaks N-1 must bump the protocol version rather than relying on
 * its minor number.
 */
export function withinRollingReleaseWindow(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (a === null || b === null) return true;
  if (a.major !== b.major) return false;
  return Math.abs(a.minor - b.minor) <= 1;
}

/**
 * A peer row written before this feature shipped has no protocol columns. Such
 * a peer is, by definition, running the release that introduced protocol 1, so
 * treat a missing value as protocol 1 rather than as a hard failure. This is
 * the expand half of expand/migrate/contract applied to the node registry
 * itself: the column can be read by new nodes before every old node writes it.
 */
function peerProtocol(peer: ClusterPeer): { protocol: number; min: number } {
  return {
    protocol: peer.protocolVersion ?? 1,
    min: peer.minProtocolVersion ?? 1,
  };
}

function describePeer(peer: ClusterPeer): string {
  const version = peer.applicationVersion ?? "unknown";
  const { protocol } = peerProtocol(peer);
  return `${peer.nodeId} (${version}, HA protocol ${String(protocol)})`;
}

/**
 * Evaluate whether this node may join the live cluster.
 *
 * `peers` should contain only nodes whose heartbeat is still fresh; a stale
 * row describes a replica that has already been replaced and must not block a
 * rollout. The local node is excluded by the caller so that a node never
 * refuses to start because of its own previous row.
 */
export function evaluateClusterCompatibility(
  local: LocalProtocolIdentity,
  peers: readonly ClusterPeer[],
): ClusterCompatibility {
  const incompatiblePeers: PeerIncompatibility[] = [];
  let oldest = local.protocolVersion;

  for (const peer of peers) {
    if (peer.nodeId === local.nodeId) continue;
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
          `peer requires at least HA protocol ${String(min)} but this release speaks ` +
          String(local.protocolVersion),
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

  const skewed = peers.filter(
    (peer): boolean =>
      peer.nodeId !== local.nodeId && !withinRollingReleaseWindow(local.applicationVersion, peer.applicationVersion),
  );
  const summary =
    skewed.length > 0
      ? `HA protocol ${String(local.protocolVersion)} is compatible, but ${String(skewed.length)} peer(s) are outside ` +
        `the N/N-1 release window: ${skewed.map(describePeer).join(", ")}`
      : `HA protocol ${String(local.protocolVersion)} is compatible with ${String(peers.length)} live peer(s)`;

  return { compatible: true, oldestPeerProtocolVersion: oldest, incompatiblePeers: [], summary };
}

export class ClusterProtocolIncompatibleError extends Error {
  public readonly incompatiblePeers: readonly PeerIncompatibility[];

  constructor(compatibility: Readonly<ClusterCompatibility>) {
    super(compatibility.summary);
    this.name = "ClusterProtocolIncompatibleError";
    this.incompatiblePeers = compatibility.incompatiblePeers;
  }
}
