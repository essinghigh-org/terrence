import { expect, test } from "bun:test";
import { startWebView, WebViewTimeoutError, withWebViewDeadline } from "./browser/helpers/webview-lifecycle";

test("a hung startup is bounded and closed without retrying the shared native process", async () => {
  let created = 0;
  let closed = 0;
  const error: unknown = await startWebView(
    () => {
      created++;
      let done = false;
      return {
        close(): void {
          if (!done) {
            done = true;
            closed++;
          }
        },
      };
    },
    () =>
      new Promise<void>(() => {
        /* Deliberately stalled native startup. */
      }),
    10,
  ).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(WebViewTimeoutError);
  expect(created).toBe(1);
  expect(closed).toBe(1);
});

test("a pending-operation error is preserved without retrying", async () => {
  let created = 0;
  let closed = 0;
  const failure = new Error("navigation is already pending");
  const error: unknown = await startWebView(
    () => {
      created++;
      return {
        close(): void {
          closed++;
        },
      };
    },
    () => Promise.reject(failure),
  ).catch((caught: unknown) => caught);
  expect(error).toBe(failure);
  expect(created).toBe(1);
  expect(closed).toBe(1);
});

test("non-transport startup errors are not retried", async () => {
  let created = 0;
  const failure = new Error("bad configuration");
  expect(
    await startWebView(
      () => {
        created++;
        return {
          close(): void {
            /* No native resources in this test. */
          },
        };
      },
      () => Promise.reject(failure),
      10,
    ).catch((error: unknown) => error),
  ).toBe(failure);
  expect(created).toBe(1);
});

test("deadline retires pending transport and safely observes rejection from close", async () => {
  let rejectPending: (error: Error) => void = () => {
    /* Deliberately pending or unused in this lifecycle test. */
  };
  const pending = new Promise<void>((_resolve, reject) => {
    rejectPending = reject;
  });
  expect(
    await withWebViewDeadline(
      () => pending,
      "evaluate at /login",
      10,
      () => {
        rejectPending(new Error("closed"));
      },
    ).catch((error: unknown) => error),
  ).toMatchObject({ message: "WebView evaluate at /login timed out after 10ms" });
});

test("successful operations clear their deadline and do not retire the page", async () => {
  let closed = false;
  expect(
    await withWebViewDeadline(
      () => Promise.resolve(42),
      "evaluate",
      10,
      () => {
        closed = true;
      },
    ),
  ).toBe(42);
  await Bun.sleep(20);
  expect(closed).toBe(false);
});

test("application errors are preserved without retry", async () => {
  const failure = new Error("accessibility violation");
  let closed = false;
  expect(
    await withWebViewDeadline(
      () => Promise.reject(failure),
      "evaluate",
      10,
      () => {
        closed = true;
      },
    ).catch((error: unknown) => error),
  ).toBe(failure);
  expect(closed).toBe(false);
});

// A cold browser may legitimately take more than the previous two-second budget.
test("cold browser startup is allowed to complete without restarting it", async () => {
  let created = 0;
  let closed = 0;
  await startWebView(
    () => {
      created++;
      return {
        close(): void {
          closed++;
        },
      };
    },
    () => Bun.sleep(2100),
  );
  expect(created).toBe(1);
  expect(closed).toBe(0);
});

test("timeout identifies the startup stage that stalled", async () => {
  const page = {
    startupStage: "navigate startup document",
    close(): void {
      /* No native resources in this test. */
    },
  };
  const error: unknown = await startWebView(
    () => page,
    () =>
      new Promise<void>(() => {
        /* Deliberately stalled startup. */
      }),
    10,
  ).catch((error: unknown) => error);
  expect(error).toMatchObject({
    message: "WebView startup handshake (navigate startup document) timed out after 10ms",
  });
});
