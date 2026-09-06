/**
 * Ownership of local execution capacity (ENG-01).
 *
 * The worker queue and the run entry points need the same lifecycle rules:
 * reserve a run before claiming it, convert that reservation into an active
 * slot when execution starts, and let shutdown wait for every local execution
 * to finish. Keeping those rules in one small service prevents the queue and
 * the execution wrappers from growing separate notions of ownership.
 *
 * This service deliberately has no database or worker imports. The worker
 * supplies the runtime capacity policy through a typed context, while tests
 * can construct an isolated owner with a deterministic limit.
 */

export type LocalExecutionLifecycleContext = Readonly<{
  concurrencyLimit: () => number;
}>;

export class LocalExecutionLifecycle {
  private draining = false;
  private activeExecutions = 0;
  private readonly activeRunExecutions = new Map<string, number>();
  private readonly reservations = new Set<string>();
  private readonly waiters: (() => void)[] = [];
  private executionIdleCallback: (() => void) | null = null;

  constructor(private readonly context: LocalExecutionLifecycleContext) {}

  /** Stop new queue claims while allowing already-owned work to finish. */
  public stop(): void {
    this.draining = true;
  }

  public isDraining(): boolean {
    return this.draining;
  }

  /**
   * Resolve when every locally executing task has settled, or false after the
   * caller's bounded shutdown grace period expires.
   */
  public async waitForDrain(graceMs: number): Promise<boolean> {
    if (this.activeExecutions === 0) return true;
    return new Promise((resolve): void => {
      const timer = setTimeout((): void => {
        this.executionIdleCallback = null;
        resolve(false);
      }, graceMs);
      this.executionIdleCallback = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
    });
  }

  /** Count a local execution so shutdown can wait for it. */
  // Promise is consumed for settlement and cannot be mutated by this service.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  public async trackExecution<T>(promise: Promise<T>): Promise<T> {
    this.activeExecutions += 1;
    const settle = (): void => {
      this.activeExecutions -= 1;
      if (this.activeExecutions === 0 && this.executionIdleCallback !== null) {
        const callback = this.executionIdleCallback;
        this.executionIdleCallback = null;
        callback();
      }
    };
    return promise.then(
      (value: T): T => {
        settle();
        return value;
      },
      (error: unknown): never => {
        settle();
        throw error;
      },
    );
  }

  public concurrencyLimit(): number {
    return this.context.concurrencyLimit();
  }

  /** Reserve one run capacity slot before atomically claiming its DB row. */
  public reserveRun(runId: string): boolean {
    if (this.activeRunExecutions.has(runId) || this.reservations.has(runId)) return true;
    if (this.capacityUsed() >= this.concurrencyLimit()) return false;
    this.reservations.add(runId);
    return true;
  }

  /** Release a pre-claim reservation after the DB claim fails. */
  public releaseReservation(runId: string): void {
    if (!this.reservations.delete(runId)) return;
    this.waiters.shift()?.();
  }

  public hasReservation(runId: string): boolean {
    return this.reservations.has(runId);
  }

  /**
   * Return true when a run has either a pre-claim reservation or an active
   * execution slot. This is the ownership check used by cleanup paths.
   */
  public hasRunExecution(runId: string): boolean {
    return this.reservations.has(runId) || this.activeRunExecutions.has(runId);
  }

  /** Number of distinct runs holding local execution slots. */
  public activeRunExecutionCount(): number {
    return this.activeRunExecutions.size;
  }

  private capacityUsed(): number {
    return this.activeRunExecutions.size + this.reservations.size;
  }

  private async acquireRunExecutionSlot(runId: string): Promise<void> {
    const activeCount = this.activeRunExecutions.get(runId);
    if (activeCount !== undefined) {
      this.activeRunExecutions.set(runId, activeCount + 1);
      return Promise.resolve();
    }
    if (!this.reservations.has(runId)) {
      return (async (): Promise<void> => {
        while (this.capacityUsed() >= this.concurrencyLimit()) {
          await new Promise<void>((resolve): void => {
            this.waiters.push(resolve);
          });
        }
        // Capacity was awaited above; this path did not hold a reservation,
        // so it can mark the slot active directly.
        this.activeRunExecutions.set(runId, 1);
      })();
    }
    this.reservations.delete(runId);
    this.activeRunExecutions.set(runId, 1);
    return Promise.resolve();
  }

  private releaseRunExecutionSlot(runId: string): void {
    const activeCount = this.activeRunExecutions.get(runId);
    if (activeCount === undefined) return;
    if (activeCount > 1) {
      this.activeRunExecutions.set(runId, activeCount - 1);
      return;
    }
    this.activeRunExecutions.delete(runId);
    this.waiters.shift()?.();
  }

  /** Convert a reservation into an active owned run for the duration of work. */
  public async trackRun<T>(runId: string, work: () => Promise<T>): Promise<T> {
    await this.acquireRunExecutionSlot(runId);
    try {
      return await work();
    } finally {
      this.releaseRunExecutionSlot(runId);
    }
  }
}
