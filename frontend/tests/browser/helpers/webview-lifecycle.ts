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

export const WEBVIEW_STARTUP_TITLE = "terrence-browser-startup";
export const WEBVIEW_STARTUP_URL = `data:text/html,%3Ctitle%3E${WEBVIEW_STARTUP_TITLE}%3C%2Ftitle%3E`;

/** Bound cold process startup separately from application assertions; do not hide failures with retries. */
export async function startWebView<T extends { close(): void; startupStage?: string }>(
  create: () => T,
  initialize: (page: T) => Promise<void>,
  timeout = 10_000,
): Promise<T> {
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
    throw error;
  }
}
