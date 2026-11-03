/** A transport deadline, not a retry of application assertions. */
export class WebViewTimeoutError extends Error {
  constructor(operation: string, timeout: number) {
    super(`WebView ${operation} timed out after ${timeout}ms`);
    this.name = "WebViewTimeoutError";
  }
}

export async function withWebViewDeadline<T>(
  operation: () => Promise<T>,
  label: string,
  timeout: number,
  retire: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // A timed-out WebView can retain a pending native operation. Never
          // reuse it, and attach the race handler before close rejects it.
          reject(new WebViewTimeoutError(label, timeout));
          retire();
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Only retry the empty browser handshake, before any application is loaded. */
export async function startWebView<T extends { close(): void }>(
  create: () => T,
  initialize: (page: T) => Promise<void>,
  timeout = 2000,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const page = create();
    try {
      await withWebViewDeadline(() => initialize(page), "startup handshake", timeout, () => { page.close(); });
      return page;
    } catch (error) {
      page.close();
      const pending = error instanceof Error && error.message.includes("already pending");
      if (attempt >= 1 || (!(error instanceof WebViewTimeoutError) && !pending)) throw error;
      console.warn(`[browser] Retrying empty WebView startup after: ${String(error)}`);
    }
  }
}
