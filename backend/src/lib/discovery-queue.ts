/** Shared admission for optional icon metadata and avatar refreshes. */
const MAX_PENDING = 64;
const MAX_PER_HOST = 32;
const MAX_ACTIVE = 8;
const MAX_ACTIVE_PER_HOST = 2;
const DEADLINE_MS = 4_000;

type Entry = Readonly<{ host: string; start: () => void }>;
const queue: Entry[] = [];
const pendingByHost = new Map<string, number>();
const activeByHost = new Map<string, number>();
let active = 0;
let rejected = 0;
let timedOut = 0;

function drain(): void {
  while (active < MAX_ACTIVE) {
    const index = queue.findIndex((entry): boolean => (activeByHost.get(entry.host) ?? 0) < MAX_ACTIVE_PER_HOST);
    if (index < 0) return;
    queue.splice(index, 1)[0]?.start();
  }
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- updates the shared admission counters.
function decrement(counts: Map<string, number>, host: string): void {
  const remaining = (counts.get(host) ?? 1) - 1;
  if (remaining === 0) counts.delete(host);
  else counts.set(host, remaining);
}

/** Null means optional work was rejected, expired, or failed. A timed-out
 * active task retains its slot until it stops, so cancellation cannot create
 * unlimited work when an upstream ignores its signal. */
export function discover<T>(host: string, operation: (signal: Readonly<AbortSignal>) => Promise<T>): Promise<T | null> | null {
  if (active + queue.length >= MAX_PENDING || (pendingByHost.get(host) ?? 0) >= MAX_PER_HOST) {
    rejected++;
    return null;
  }
  pendingByHost.set(host, (pendingByHost.get(host) ?? 0) + 1);
  const controller = new AbortController();
  return new Promise<T | null>((resolve): void => {
    let started = false;
    const timer = setTimeout((): void => {
      timedOut++;
      controller.abort();
      if (!started) {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        decrement(pendingByHost, host);
        drain();
      }
      resolve(null);
    }, DEADLINE_MS);
    const entry: Entry = {
      host,
      start: (): void => {
        started = true;
        active++;
        activeByHost.set(host, (activeByHost.get(host) ?? 0) + 1);
        void Promise.resolve().then(async (): Promise<T> => operation(controller.signal)).then(resolve, (): void => { resolve(null); }).finally((): void => {
          clearTimeout(timer);
          active--;
          decrement(activeByHost, host);
          decrement(pendingByHost, host);
          drain();
        });
      },
    };
    queue.push(entry);
    drain();
  });
}

/** Aggregate-only instance metrics: no registry hostnames or credentials. */
export function discoveryStats(): Readonly<{ active: number; queued: number; rejected: number; timedOut: number; limit: number }> {
  return { active, queued: queue.length, rejected, timedOut, limit: MAX_PENDING };
}
