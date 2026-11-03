/** A transport deadline, not a retry of application assertions. */
export class WebViewTimeoutError extends Error {
  constructor(operation: string, timeout: number) {
    super(`WebView ${operation} timed out after ${timeout}ms`);
    this.name = "WebViewTimeoutError";
  }
}

export async function withWebViewDeadline<T>(
  operation: () => Promise<T>,
  label: string | (() => string),
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
          reject(new WebViewTimeoutError(typeof label === "function" ? label() : label, timeout));
          retire();
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Only retry the empty browser handshake, before any application is loaded.
 * Bun launches Chrome asynchronously: the first navigation includes cold process
 * startup, not just navigation. Keep that budget separate from app assertions.
 */
export async function startWebView<T extends { close(): void; startupStage?: string }>(
  create: () => T,
  initialize: (page: T) => Promise<void>,
  timeout = 10_000,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const page = create();
    try {
      await withWebViewDeadline(
        () => initialize(page),
        () => `startup handshake${page.startupStage ? ` (${page.startupStage})` : ""}`,
        timeout,
        () => {
          page.close();
        },
      );
      return page;
    } catch (error) {
      page.close();
      const pending = error instanceof Error && error.message.includes("already pending");
      if (attempt >= 1 || (!(error instanceof WebViewTimeoutError) && !pending)) throw error;
      console.warn(`[browser] Retrying empty WebView startup after: ${String(error)}`);
    }
  }
}
