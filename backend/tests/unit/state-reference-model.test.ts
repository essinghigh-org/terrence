import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type StateEvent = Readonly<{
  kind: "reserve" | "commit" | "publish" | "delete" | "handoff" | "execution";
  id?: string;
  serial?: number;
  owner?: string;
  active?: boolean;
}>;

type StateSeed = Readonly<{
  name: string;
  owner: string;
  events: readonly StateEvent[];
}>;

type ReferenceState = Readonly<{
  owner: string;
  latestSerial: number;
  reservations: ReadonlyMap<string, number>;
  committed: ReadonlySet<string>;
  published: ReadonlySet<string>;
  activeExecutions: ReadonlySet<string>;
  deletedExecutions: ReadonlySet<string>;
  appliedEvents: ReadonlySet<string>;
}>;

const seeds = JSON.parse(
  readFileSync(join(import.meta.dir, "../fixtures/property-model/state-events.json"), "utf8"),
) as StateSeed[];

function applyReference(state: ReferenceState, event: StateEvent, eventKey: string): ReferenceState {
  if (state.appliedEvents.has(eventKey)) return state;
  const appliedEvents = new Set(state.appliedEvents).add(eventKey);
  if (event.kind === "handoff" && typeof event.owner === "string") {
    return { ...state, owner: event.owner, appliedEvents };
  }
  if (event.owner !== state.owner) return { ...state, appliedEvents };
  const reservations = new Map(state.reservations);
  const committed = new Set(state.committed);
  const published = new Set(state.published);
  const activeExecutions = new Set(state.activeExecutions);
  const deletedExecutions = new Set(state.deletedExecutions);
  if (event.kind === "reserve" && event.id !== undefined && event.serial !== undefined && event.serial > state.latestSerial) {
    reservations.set(event.id, event.serial);
    return { ...state, reservations, appliedEvents };
  }
  if (event.kind === "commit" && event.id !== undefined && event.serial !== undefined
    && reservations.get(event.id) === event.serial && event.serial > state.latestSerial) {
    committed.add(event.id);
    return { ...state, latestSerial: event.serial, committed, appliedEvents };
  }
  if (event.kind === "publish" && event.id !== undefined && event.serial === state.latestSerial
    && committed.has(event.id)) {
    published.add(event.id);
    return { ...state, published, appliedEvents };
  }
  if (event.kind === "execution" && event.id !== undefined) {
    if (deletedExecutions.has(event.id)) return { ...state, appliedEvents };
    if (event.active === true) activeExecutions.add(event.id);
    else activeExecutions.delete(event.id);
    return { ...state, activeExecutions, appliedEvents };
  }
  if (event.kind === "delete" && event.id !== undefined && !activeExecutions.has(event.id)) {
    deletedExecutions.add(event.id);
    return { ...state, deletedExecutions, appliedEvents };
  }
  return { ...state, appliedEvents };
}

function initialState(owner: string): ReferenceState {
  return {
    owner,
    latestSerial: 0,
    reservations: new Map(),
    committed: new Set(),
    published: new Set(),
    activeExecutions: new Set(),
    deletedExecutions: new Set(),
    appliedEvents: new Set(),
  };
}

function rand32(seed: number): () => number {
  let value = seed >>> 0;
  return (): number => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("independent state serial and execution model", () => {
  it("keeps minimized stale-owner, duplicate, reorder, and active-delete seeds safe", () => {
    for (const seed of seeds) {
      let state = initialState(seed.owner);
      for (const [index, event] of seed.events.entries()) state = applyReference(state, event, `${seed.name}:${index}`);
      // Replaying the exact events is a no-op, including a duplicate commit.
      const replay = seed.events.reduce(
        (current, event, index) => applyReference(current, event, `${seed.name}:${index}`),
        state,
      );
      expect(replay).toEqual(state);
      expect([...state.published].every((id) => state.committed.has(id))).toBe(true);
      expect([...state.deletedExecutions].every((id) => !state.activeExecutions.has(id))).toBe(true);
      expect(state.latestSerial).toBeGreaterThanOrEqual(0);
    }
  });

  it("generates deterministic event sequences without double apply or stale publication", () => {
    const requested = Number.parseInt(process.env["TERRENCE_PROPERTY_CASES"] ?? "256", 10);
    const cases = Number.isSafeInteger(requested) && requested > 0 && requested <= 10_000 ? requested : 256;
    for (let seed = 1; seed <= cases; seed += 1) {
      const random = rand32(seed);
      let state = initialState(`owner-${seed}`);
      const events: StateEvent[] = [];
      for (let index = 0; index < 24; index += 1) {
        const id = `sv-${seed}-${Math.floor(random() * 4)}`;
        const serial = 1 + Math.floor(random() * 6);
        const owner = random() < 0.2 ? `stale-${seed}` : state.owner;
        const kind = ["reserve", "commit", "publish", "delete", "execution"][
          Math.floor(random() * 5)
        ] as StateEvent["kind"];
        events.push({ kind, id, serial, owner, active: random() < 0.5 });
        if (random() < 0.25) events.push(events.at(-1)!);
        state = applyReference(state, events.at(-1)!, `${seed}:${events.length - 1}`);
      }
      expect([...state.published].every((id) => state.committed.has(id))).toBe(true);
      expect([...state.deletedExecutions].every((id) => !state.activeExecutions.has(id))).toBe(true);
      expect(state.latestSerial).toBeLessThanOrEqual(6);
    }
  });
});
