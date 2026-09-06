/** Reasons that can stop an operation before it reaches its normal result. */
export type OperationCancellationReason =
  | "client-disconnect"
  | "user-cancel"
  | "deadline"
  | "lease-lost"
  | "shutdown"
  | "infrastructure-failure";

/** Stable error shape for callers that need to distinguish a stop cause. */
export class OperationCanceledError extends Error {
  public readonly reason: OperationCancellationReason;

  constructor(reason: OperationCancellationReason, cause?: unknown) {
    const detail = cause instanceof Error
      ? `: ${cause.message}`
      : cause === undefined
        ? ""
        : typeof cause === "string"
          ? `: ${cause}`
          : ": cancellation cause was not an Error";
    super(`Operation canceled (${reason})${detail}`, cause === undefined ? undefined : { cause });
    this.name = "OperationCanceledError";
    this.reason = reason;
  }
}

export type OperationContextOptions = Readonly<{
  /** Parent request/job signal. The context owns a child signal. */
  signal?: Readonly<AbortSignal>;
  /** Operation-specific wall-clock budget. Omit when the caller has no deadline. */
  deadlineMs?: number;
  /** Reason assigned when the parent signal is not an OperationCanceledError. */
  parentReason?: OperationCancellationReason;
}>;

export type OperationContext = Readonly<{
  signal: Readonly<AbortSignal>;
  deadlineAt: number | null;
  reason: OperationCancellationReason | null;
  /** Abort once and report whether this call won the race. */
  cancel: (reason: OperationCancellationReason, cause?: unknown) => boolean;
  /** Release timers/listeners. Safe to call more than once. */
  dispose: () => void;
}>;

function parentCancellationReason(
  signal: Readonly<AbortSignal>,
  fallback: OperationCancellationReason,
): OperationCancellationReason {
  const reason: unknown = signal.reason;
  return reason instanceof OperationCanceledError ? reason.reason : fallback;
}

/**
 * Create a child cancellation scope for one operation.
 *
 * A scope has no implicit deadline. Callers choose a budget appropriate for
 * their phase (archive inspection, provider request, or job lease) and all
 * resources in that phase can share the resulting signal. `dispose` only
 * releases the scope's timer/listener; it never changes the operation result.
 */
export function createOperationContext(options: OperationContextOptions = {}): OperationContext {
  if (options.deadlineMs !== undefined && (!Number.isFinite(options.deadlineMs) || options.deadlineMs < 0)) {
    throw new RangeError("Operation deadline must be a finite non-negative number");
  }

  const controller = new AbortController();
  let cancellationReason: OperationCancellationReason | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const deadlineAt = options.deadlineMs === undefined ? null : Date.now() + options.deadlineMs;
  const parentSignal = options.signal;
  const fallbackParentReason = options.parentReason ?? "client-disconnect";

  const cancel = (reason: OperationCancellationReason, cause?: unknown): boolean => {
    if (controller.signal.aborted) return false;
    cancellationReason = reason;
    controller.abort(new OperationCanceledError(reason, cause));
    return true;
  };

  const onParentAbort = (): void => {
    if (parentSignal === undefined) return;
    cancel(parentCancellationReason(parentSignal, fallbackParentReason), parentSignal.reason);
  };
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  if (options.deadlineMs !== undefined) {
    deadlineTimer = setTimeout((): void => {
      cancel("deadline", new Error(`Operation deadline exceeded after ${String(options.deadlineMs)} ms`));
    }, options.deadlineMs);
    deadlineTimer.unref?.();
  }

  if (parentSignal?.aborted === true) onParentAbort();
  if (options.deadlineMs === 0) cancel("deadline", new Error("Operation deadline exceeded before starting"));

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  };

  return {
    signal: controller.signal,
    deadlineAt,
    get reason(): OperationCancellationReason | null { return cancellationReason; },
    cancel,
    dispose,
  };
}
