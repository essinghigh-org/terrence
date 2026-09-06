import { expect, test } from "bun:test";
import { processSnapshot } from "../../src/lib/process-metrics";
import { discover, discoveryStats } from "../../src/lib/discovery-queue";
import { cacheOrganizationName, cachedOrganizationName, clearMetadataCache } from "../../src/lib/metadata-cache";

test("bounds total discovery work and reserves capacity for unrelated hosts", async () => {
  const before = discoveryStats();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requests = Array.from({ length: 5000 }, () => discover("slow.example", async () => { await gate; return "slow"; }));
  try {
    expect(requests.filter((request) => request !== null)).toHaveLength(32);
    expect(discoveryStats()).toMatchObject({ active: 2, queued: 30, rejected: before.rejected + 4968 });
    expect(await discover("fast.example", async () => "fast")).toBe("fast");
    await Bun.sleep(0);
    requests.push(...Array.from({ length: 32 }, (_, i) => discover(`other-${i}.example`, async () => { await gate; return "other"; })));
    expect(discoveryStats()).toMatchObject({ active: 8, queued: 56 });
    expect(processSnapshot().discovery).toEqual(discoveryStats());
    expect(discover("overflow.example", async () => "never")).toBeNull();
  } finally { release(); await Promise.all(requests.filter((request): request is Promise<string | null> => request !== null)); }
  await Bun.sleep(0);
  expect(discoveryStats()).toMatchObject({ active: 0, queued: 0 });
});

test("expires queued work without running it and keeps canceled active work counted until it stops", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const signals: AbortSignal[] = [];
  let queuedStarted = false;
  const active = Array.from({ length: 2 }, () => discover("timeout.example", async (signal) => {
    signals.push(signal);
    await gate; // Deliberately ignore cancellation to check admission safety.
    return true;
  }));
  const queued = discover("timeout.example", async () => { queuedStarted = true; return true; });
  try {
    expect(await Promise.all([...active, queued])).toEqual([null, null, null]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(queuedStarted).toBe(false);
    expect(discoveryStats()).toMatchObject({ active: 2, queued: 0 });
  } finally { release(); await Bun.sleep(0); }
  expect(discoveryStats()).toMatchObject({ active: 0, queued: 0 });
}, 7000);

test("metadata cache has a fixed entry budget", () => {
  clearMetadataCache();
  for (let i = 0; i < 2000; i++) cacheOrganizationName(`org-${i}`, `name-${i}`);
  expect(cachedOrganizationName("org-0")).toBeUndefined();
  expect(cachedOrganizationName("org-1999")).toBe("name-1999");
  clearMetadataCache();
});
