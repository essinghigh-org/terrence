export type BrowserOptions = {
  width?: number;
  height?: number;
  backend?: "chrome" | "webkit";
};

export type GotoOptions = {
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  timeout?: number;
  initStorage?: Record<string, string>;
};

export type WaitForSelectorOptions = {
  timeout?: number;
  state?: "attached" | "visible" | "hidden";
};

export type ScreenshotOptions = {
  fullPage?: boolean;
  mask?: string[];
};

const INJECT_MONITOR_SCRIPT = `
(() => {
  if (window.__terrence_monitor_installed) return;
  window.__terrence_monitor_installed = true;
  window.__terrence_page_errors = window.__terrence_page_errors || [];
  window.__terrence_console_errors = window.__terrence_console_errors || [];
  window.__terrence_pending_fetches = window.__terrence_pending_fetches || 0;

  window.addEventListener("error", (event) => {
    const message = event.error?.stack || event.message || String(event.error || event);
    window.__terrence_page_errors.push(message);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    window.__terrence_page_errors.push("Unhandled rejection: " + message);
  });

  const originalConsoleError = console.error;
  console.error = (...args) => {
    const text = args
      .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
      .join(" ");
    window.__terrence_console_errors.push(text);
    originalConsoleError.apply(console, args);
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async (...args) => {
      window.__terrence_pending_fetches++;
      try {
        return await originalFetch(...args);
      } finally {
        window.__terrence_pending_fetches = Math.max(0, window.__terrence_pending_fetches - 1);
      }
    };
  }
})();
`;

export class BrowserPage {
  readonly webview: InstanceType<typeof Bun.WebView>;
  readonly consoleErrors: string[] = [];
  readonly pageErrors: string[] = [];
  private initScripts: string[] = [];

  constructor(options: BrowserOptions = {}) {
    this.webview = new Bun.WebView({
      ...(options.backend !== undefined ? { backend: options.backend } : {}),
      width: options.width ?? 1440,
      height: options.height ?? 1000,
    });
  }

  get url(): string {
    return this.webview.url;
  }

  async collectErrors(): Promise<{ pageErrors: string[]; consoleErrors: string[] }> {
    try {
      const result = await this.evaluate<{ pageErrors: string[]; consoleErrors: string[] }>(`
        (() => {
          const pe = window.__terrence_page_errors ? [...window.__terrence_page_errors] : [];
          const ce = window.__terrence_console_errors ? [...window.__terrence_console_errors] : [];
          if (window.__terrence_page_errors) window.__terrence_page_errors.length = 0;
          if (window.__terrence_console_errors) window.__terrence_console_errors.length = 0;
          return { pageErrors: pe, consoleErrors: ce };
        })()
      `);
      if (result && Array.isArray(result.pageErrors)) {
        this.pageErrors.push(...result.pageErrors);
      }
      if (result && Array.isArray(result.consoleErrors)) {
        this.consoleErrors.push(...result.consoleErrors);
      }
    } catch {
      // WebView might be closed or navigating
    }
    return { pageErrors: this.pageErrors, consoleErrors: this.consoleErrors };
  }

  async clearInitScripts(): Promise<void> {
    this.initScripts = [];
  }

  async addInitScript<T = unknown>(fnOrScript: string | ((arg: T) => void), arg?: T): Promise<void> {
    let script: string;
    if (typeof fnOrScript === "function") {
      script = `(${fnOrScript.toString()})(${JSON.stringify(arg)})`;
    } else {
      script = fnOrScript;
    }
    this.initScripts.push(script);
    await this.webview.evaluate(script).catch(() => {
      // Ignore evaluation errors before document load
    });
  }

  async goto(url: string, options: GotoOptions = {}): Promise<void> {
    const timeout = options.timeout ?? 15000;

    // Set initial localStorage items if provided before navigate if already on origin
    if (options.initStorage) {
      const storagePairs = Object.entries(options.initStorage);
      const setStorageScript = `
        (() => {
          try {
            ${storagePairs.map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n")}
          } catch {}
        })()
      `;
      await this.webview.evaluate(setStorageScript).catch(() => {});
    }

    await this.webview.navigate(url);
    await Bun.sleep(50);

    // Set initial localStorage items if provided after navigation starts
    if (options.initStorage) {
      const storagePairs = Object.entries(options.initStorage);
      const setStorageScript = `
        (() => {
          try {
            ${storagePairs.map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n")}
          } catch {}
        })()
      `;
      await this.webview.evaluate(setStorageScript).catch(() => {});
    }

    // Inject monitor script immediately
    await this.webview.evaluate(INJECT_MONITOR_SCRIPT).catch(() => {});

    // Run registered init scripts
    for (const script of this.initScripts) {
      await this.webview.evaluate(script).catch(() => {});
    }

    // Wait for target readiness state
    const start = Date.now();
    let ready = false;

    if (options.waitUntil === "commit") {
      ready = true;
    } else {
      while (Date.now() - start < timeout) {
        // Re-inject monitor if page changed/reloaded
        await this.webview.evaluate(INJECT_MONITOR_SCRIPT).catch(() => {});

        const readyState = await this.evaluate<string>("document.readyState").catch(() => "loading");
        if (options.waitUntil === "domcontentloaded") {
          if (readyState === "interactive" || readyState === "complete") {
            ready = true;
            break;
          }
        } else if (options.waitUntil === "networkidle") {
          const pendingFetches = await this.evaluate<number>("window.__terrence_pending_fetches || 0").catch(() => 0);
          if (readyState === "complete" && pendingFetches === 0) {
            // Settle check
            await Bun.sleep(100);
            const stillPending = await this.evaluate<number>("window.__terrence_pending_fetches || 0").catch(() => 0);
            if (stillPending === 0) {
              ready = true;
              break;
            }
          }
        } else {
          if (readyState === "complete") {
            ready = true;
            break;
          }
        }
        await Bun.sleep(50);
      }
    }

    if (!ready) {
      throw new Error(`Timeout waiting for "${url}" to reach readyState "${options.waitUntil ?? "complete"}"`);
    }

    await this.collectErrors();
  }

  async waitForAppReady(selector = "#root", options: { timeout?: number } = {}): Promise<void> {
    const timeout = options.timeout ?? 15000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const ready = await this.evaluate(`
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el || el.children.length === 0) return false;
          const fallbackSpinner = el.querySelector('.py-24 [data-slot="spinner"]');
          if (fallbackSpinner && el.children.length === 1) {
            return false;
          }
          return true;
        })()
      `).catch(() => false);

      if (ready) {
        await Bun.sleep(150);
        await this.collectErrors();
        return;
      }
      await Bun.sleep(50);
    }
    await this.collectErrors();
    throw new Error(`Timeout waiting for React application to mount at "${selector}" (pageErrors: ${JSON.stringify(this.pageErrors)}, consoleErrors: ${JSON.stringify(this.consoleErrors)})`);
  }

  async evaluate<T = unknown>(fnOrScript: string | ((...args: unknown[]) => unknown), ...args: unknown[]): Promise<T> {
    let script: string;
    if (typeof fnOrScript === "function") {
      script = `(${fnOrScript.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;
    } else {
      script = fnOrScript;
    }
    const result = (await this.webview.evaluate(script)) as T;
    return result;
  }

  async waitForTimeout(ms: number): Promise<void> {
    await Bun.sleep(ms);
  }

  async waitForSelector(selector: string, options: WaitForSelectorOptions = {}): Promise<boolean> {
    const timeout = options.timeout ?? 10000;
    const state = options.state ?? "visible";
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const isMatch = await this.evaluate<boolean>(`
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return ${state === "hidden"};
          if (${state === "attached"}) return true;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          return ${state === "visible"} ? visible : !visible;
        })()
      `).catch(() => false);

      if (isMatch) return true;
      await Bun.sleep(50);
    }
    throw new Error(`Timeout waiting for selector "${selector}" with state "${state}"`);
  }

  async waitForURL(pattern: string | RegExp, options: { timeout?: number } = {}): Promise<void> {
    const timeout = options.timeout ?? 10000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const current = this.webview.url;
      const match = typeof pattern === "string" ? current.includes(pattern) : pattern.test(current);
      if (match) return;
      await Bun.sleep(50);
    }
    throw new Error(`Timeout waiting for URL matching ${String(pattern)}, current URL is "${this.webview.url}"`);
  }

  async isVisible(selector: string): Promise<boolean> {
    return await this.evaluate<boolean>(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      })()
    `).catch(() => false);
  }

  async textContent(selector: string): Promise<string | null> {
    return await this.evaluate<string | null>(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? el.textContent : null;
      })()
    `);
  }

  async innerText(selector: string): Promise<string | null> {
    return await this.evaluate<string | null>(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? el.innerText : null;
      })()
    `);
  }

  async click(selector: string): Promise<void> {
    const found = await this.evaluate<boolean>(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: "center", inline: "center" });
        el.click();
        return true;
      })()
    `);
    if (!found) {
      throw new Error(`Element not found for click: ${selector}`);
    }
  }

  async fill(selector: string, value: string): Promise<void> {
    const found = await this.evaluate<boolean>(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()
    `);
    if (!found) {
      throw new Error(`Element not found for fill: ${selector}`);
    }
  }

  async type(selector: string, text: string): Promise<void> {
    await this.fill(selector, text);
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const hasMask = options.mask && options.mask.length > 0;
    if (hasMask) {
      await this.evaluate(`
        (() => {
          window.__terrence_masked_elements = [];
          for (const sel of ${JSON.stringify(options.mask)}) {
            document.querySelectorAll(sel).forEach((el) => {
              window.__terrence_masked_elements.push({
                el,
                prevVisibility: el.style.visibility
              });
              el.style.visibility = "hidden";
            });
          }
        })()
      `);
    }

    try {
      const blob = await this.webview.screenshot();
      return Buffer.from(await blob.arrayBuffer());
    } finally {
      if (hasMask) {
        await this.evaluate(`
          (() => {
            if (window.__terrence_masked_elements) {
              window.__terrence_masked_elements.forEach(({ el, prevVisibility }) => {
                el.style.visibility = prevVisibility;
              });
              delete window.__terrence_masked_elements;
            }
          })()
        `).catch(() => {});
      }
    }
  }

  close(): void {
    try {
      this.webview.close();
    } catch {}
  }
}

export async function createBrowser(options: BrowserOptions = {}): Promise<BrowserPage> {
  return new BrowserPage(options);
}
