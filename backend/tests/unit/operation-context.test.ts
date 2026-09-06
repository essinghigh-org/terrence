import { describe, expect, test } from "bun:test";
import {
  createOperationContext,
  OperationCanceledError,
} from "../../src/lib/operation-context";

describe("operation cancellation context", () => {
  test("does not invent a deadline when the operation has no budget", async () => {
    const context = createOperationContext();
    await Bun.sleep(20);
    expect(context.deadlineAt).toBeNull();
    expect(context.signal.aborted).toBeFalse();
    context.dispose();
  });

  test("preserves the parent stop reason and makes cancellation idempotent", () => {
    const parent = new AbortController();
    const context = createOperationContext({ signal: parent.signal });

    parent.abort(new Error("browser disconnected"));

    expect(context.signal.reason).toBeInstanceOf(OperationCanceledError);
    expect((context.signal.reason as OperationCanceledError).reason).toBe("client-disconnect");
    expect((context.signal.reason as Error).message).toContain("browser disconnected");
    expect(context.cancel("shutdown")).toBeFalse();
    context.dispose();
  });

  test("uses the caller's deadline and classifies it separately from cancellation", async () => {
    const context = createOperationContext({ deadlineMs: 20 });
    await new Promise<void>((resolve): void => {
      context.signal.addEventListener("abort", (): void => { resolve(); }, { once: true });
    });

    expect(context.deadlineAt).not.toBeNull();
    expect(context.reason).toBe("deadline");
    expect((context.signal.reason as OperationCanceledError).reason).toBe("deadline");
    context.dispose();
  });

  test("rejects an invalid deadline instead of silently applying a shared timeout", () => {
    expect(() => createOperationContext({ deadlineMs: -1 })).toThrow("finite non-negative");
  });
});
