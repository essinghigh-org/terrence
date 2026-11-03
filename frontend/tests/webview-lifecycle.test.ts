import { expect, test } from "bun:test";
import { startWebView, WebViewTimeoutError, withWebViewDeadline } from "./browser/helpers/webview-lifecycle";

test("startup retires a hung instance and handshakes a fresh one", async () => {
  const instances: { closed: boolean; close(): void }[] = [];
  const page = await startWebView(
    () => {
      const instance = {
        closed: false,
        close(): void {
          this.closed = true;
        },
      };
      instances.push(instance);
      return instance;
    },
    () =>
      instances.length === 1
        ? new Promise<void>(() => {
            /* Deliberately pending or unused in this lifecycle test. */
          })
        : Promise.resolve(),
    10,
  );
  expect(instances).toHaveLength(2);
  expect(instances[0]?.closed).toBe(true);
  expect(page).toBe(instances[1]!);
  expect(page.closed).toBe(false);
});

test("persistent startup hangs are bounded and every instance is closed", async () => {
  let created = 0;
  let closed = 0;
  expect(
    await startWebView(
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
          /* Deliberately pending or unused in this lifecycle test. */
        }),
      10,
    ).catch((error: unknown) => error),
  ).toBeInstanceOf(WebViewTimeoutError);
  expect(created).toBe(2);
  expect(closed).toBe(2);
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
