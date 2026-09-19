import { describe, expect, test } from "bun:test";
import {
  HA_MIN_COMPATIBLE_PROTOCOL_VERSION,
  HA_PROTOCOL_VERSION,
  evaluateClusterCompatibility,
  localProtocolIdentity,
  parseReleaseVersion,
  withinRollingReleaseWindow,
  type ClusterPeer,
} from "../../src/lib/ha-protocol";

const local = (protocolVersion: number, minProtocolVersion: number, applicationVersion = "1.5.0") => ({
  nodeId: "node-local",
  applicationVersion,
  protocolVersion,
  minProtocolVersion,
});

const peer = (
  nodeId: string,
  protocolVersion: number | null,
  minProtocolVersion: number | null,
  applicationVersion: string | null = "1.5.0",
): ClusterPeer => ({ nodeId, applicationVersion, protocolVersion, minProtocolVersion });

describe("HA protocol version parsing", () => {
  test("parses released versions and ignores build metadata", () => {
    expect(parseReleaseVersion("1.5.0")).toEqual({ major: 1, minor: 5, patch: 0 });
    expect(parseReleaseVersion("v2.10.3")).toEqual({ major: 2, minor: 10, patch: 3 });
    expect(parseReleaseVersion("1.5.0-rc.1")).toEqual({ major: 1, minor: 5, patch: 0 });
  });

  test("returns null for development builds rather than guessing", () => {
    expect(parseReleaseVersion("dev")).toBeNull();
    expect(parseReleaseVersion("")).toBeNull();
    expect(parseReleaseVersion(null)).toBeNull();
  });

  test("treats N and N-1 minors as inside the rolling window", () => {
    expect(withinRollingReleaseWindow("1.5.0", "1.4.0")).toBe(true);
    expect(withinRollingReleaseWindow("1.5.1", "1.5.0")).toBe(true);
    expect(withinRollingReleaseWindow("1.6.0", "1.4.0")).toBe(false);
    expect(withinRollingReleaseWindow("2.0.0", "1.9.0")).toBe(false);
  });

  test("an unparseable version is not treated as evidence of incompatibility", () => {
    // Refusing to boot a development build against a released peer would make
    // local debugging of an HA cluster impossible; the protocol version, which
    // every build advertises, remains the authoritative contract.
    expect(withinRollingReleaseWindow("dev", "1.5.0")).toBe(true);
  });
});

describe("cluster compatibility", () => {
  test("accepts a peer one protocol version behind inside the supported window", () => {
    const result = evaluateClusterCompatibility(local(2, 1), [peer("node-old", 1, 1, "1.4.0")]);
    expect(result.compatible).toBe(true);
    expect(result.oldestPeerProtocolVersion).toBe(1);
    expect(result.incompatiblePeers).toHaveLength(0);
  });

  test("rejects a peer older than this release is willing to serve alongside", () => {
    const result = evaluateClusterCompatibility(local(3, 2), [peer("node-ancient", 1, 1, "1.3.0")]);
    expect(result.compatible).toBe(false);
    expect(result.incompatiblePeers).toHaveLength(1);
    expect(result.incompatiblePeers[0]?.nodeId).toBe("node-ancient");
    expect(result.summary).toContain("node-ancient");
  });

  test("gives the incumbent peer a veto over a newer joining node", () => {
    // The joining node speaks protocol 2 and would happily accept protocol 1,
    // but the live peer has already declared it will not serve below 3. The
    // check is an intersection of both advertised windows, so this must fail.
    const result = evaluateClusterCompatibility(local(2, 1), [peer("node-strict", 4, 3, "2.0.0")]);
    expect(result.compatible).toBe(false);
    expect(result.incompatiblePeers[0]?.reason).toContain("requires at least HA protocol 3");
  });

  test("reads a peer written before the protocol columns existed as protocol 1", () => {
    // Expand/migrate/contract applied to the node registry itself: a node from
    // the release that introduced these columns has them null.
    const result = evaluateClusterCompatibility(local(2, 1), [peer("node-legacy", null, null, "1.4.0")]);
    expect(result.compatible).toBe(true);
    expect(result.oldestPeerProtocolVersion).toBe(1);
  });

  test("never rejects a cluster because of the node's own row", () => {
    const identity = local(2, 2);
    const result = evaluateClusterCompatibility(identity, [peer(identity.nodeId, 1, 1, "1.4.0")]);
    expect(result.compatible).toBe(true);
  });

  test("reports release skew inside a compatible protocol as advisory only", () => {
    const result = evaluateClusterCompatibility(local(1, 1, "1.7.0"), [peer("node-lagging", 1, 1, "1.2.0")]);
    expect(result.compatible).toBe(true);
    expect(result.summary).toContain("outside");
    expect(result.summary).toContain("node-lagging");
  });

  test("an empty cluster is compatible", () => {
    const result = evaluateClusterCompatibility(local(HA_PROTOCOL_VERSION, HA_MIN_COMPATIBLE_PROTOCOL_VERSION), []);
    expect(result.compatible).toBe(true);
    expect(result.oldestPeerProtocolVersion).toBe(HA_PROTOCOL_VERSION);
  });

  test("this release declares a window of at most one protocol version", () => {
    // The supported skew is N/N-1. A release that widens this has changed the
    // rolling-upgrade contract and must say so deliberately.
    expect(HA_PROTOCOL_VERSION - HA_MIN_COMPATIBLE_PROTOCOL_VERSION).toBeLessThanOrEqual(1);
    const identity = localProtocolIdentity("node-a", "1.5.0");
    expect(identity.protocolVersion).toBe(HA_PROTOCOL_VERSION);
    expect(identity.minProtocolVersion).toBe(HA_MIN_COMPATIBLE_PROTOCOL_VERSION);
  });
});
