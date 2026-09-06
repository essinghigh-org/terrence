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
let canceled = 0;

export type DiscoveryOptions = Readonly<{ signal?: AbortSignal }>;

function canonicalHost(host: string): string {
  const normalized = host.trim().toLowerCase().replace(/\.+$/, "");
  return normalized === "" ? "<unknown>" : normalized;
}

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

/** Null means optional work was rejected, canceled, expired, or failed. A
 * canceled or timed-out active task retains its slot until it stops, so an
 * upstream that ignores its signal cannot create unlimited work. */
export function discover<T>(
  host: string,
  operation: (signal: Readonly<AbortSignal>) => Promise<T>,
  options: DiscoveryOptions = {},
): Promise<T | null> | null {
  const hostKey = canonicalHost(host);
  const callerSignal = options.signal;
  if (callerSignal?.aborted === true) {
    canceled++;
    return null;
  }
  if (active + queue.length >= MAX_PENDING || (pendingByHost.get(hostKey) ?? 0) >= MAX_PER_HOST) {
    rejected++;
    return null;
  }
  pendingByHost.set(hostKey, (pendingByHost.get(hostKey) ?? 0) + 1);
  const controller = new AbortController();
  return new Promise<T | null>((resolve): void => {
    let started = false;
    let settled = false;
    let operationFinished = false;
    let releaseIssued = false;
    const settle = (value: T | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const removeCallerListener = (): void => {
      callerSignal?.removeEventListener("abort", onCallerAbort);
    };
    const cancel = (count: boolean): void => {
      if (operationFinished || releaseIssued) return;
      releaseIssued = true;
      if (count) canceled++;
      controller.abort();
      clearTimeout(timer);
      if (!started) {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        decrement(pendingByHost, hostKey);
        removeCallerListener();
        settle(null);
        drain();
      } else {
        // The operation may ignore AbortSignal. Keep active/pending counters
        // until its promise settles, while releasing the caller promptly.
        settle(null);
      }
    };
    const onCallerAbort = (): void => {
      cancel(true);
    };
    const timer = setTimeout((): void => {
      timedOut++;
      cancel(false);
    }, DEADLINE_MS);
    const entry: Entry = {
      host: hostKey,
      start: (): void => {
        if (settled) return;
        started = true;
        active++;
        activeByHost.set(hostKey, (activeByHost.get(hostKey) ?? 0) + 1);
        void Promise.resolve()
          .then(async (): Promise<T> => operation(controller.signal))
          .then((value): void => {
            operationFinished = true;
            settle(value);
          }, (): void => {
            operationFinished = true;
            settle(null);
          })
          .finally((): void => {
            settled = true;
            clearTimeout(timer);
            removeCallerListener();
            active--;
            decrement(activeByHost, hostKey);
            decrement(pendingByHost, hostKey);
            drain();
          });
      },
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    queue.push(entry);
    drain();
  });
}

/** Aggregate-only instance metrics: no registry hostnames or credentials. */
export function discoveryStats(): Readonly<{ active: number; queued: number; rejected: number; canceled: number; timedOut: number; limit: number }> {
  return { active, queued: queue.length, rejected, canceled, timedOut, limit: MAX_PENDING };
}
