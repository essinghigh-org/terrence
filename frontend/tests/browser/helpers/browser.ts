export type BrowserOptions = {
  width?: number;
  height?: number;
  backend?: "chrome" | "safari";
}

export type GotoOptions = {
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  timeout?: number;
}

export type WaitForSelectorOptions = {
  timeout?: number;
  state?: "attached" | "visible" | "hidden";
}

export type ScreenshotOptions = {
  fullPage?: boolean;
  mask?: string[];
}

export class BrowserPage {
  readonly webview: InstanceType<typeof Bun.WebView>;
  readonly consoleErrors: string[] = [];
  readonly pageErrors: string[] = [];

  constructor(options: BrowserOptions = {}) {
    this.webview = new Bun.WebView({
      backend: options.backend ?? "chrome",
      width: options.width ?? 1440,
      height: options.height ?? 1000,
    });
  }

  get url(): string {
    return this.webview.url;
  }

  async goto(url: string, options: GotoOptions = {}): Promise<void> {
    const timeout = options.timeout ?? 15000;
    await this.webview.navigate(url);

    // Wait for document to be ready
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const readyState = await this.evaluate<string>("document.readyState").catch(() => "loading");
      if (options.waitUntil === "domcontentloaded") {
        if (readyState === "interactive" || readyState === "complete") break;
      } else {
        if (readyState === "complete") break;
      }
      await Bun.sleep(50);
    }

    if (options.waitUntil === "networkidle") {
      // Allow dynamic fetches/rendering to settle
      await Bun.sleep(200);
    }
  }

   
  async evaluate<T = any>(fnOrScript: string | ((...args: any[]) => any), ...args: any[]): Promise<T> {
    let script: string;
    if (typeof fnOrScript === "function") {
      script = `(${fnOrScript.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;
    } else {
      script = fnOrScript;
    }
    return (await this.webview.evaluate(script)) as T;
  }

  async addInitScript<T = unknown>(fnOrScript: string | ((arg: T) => void), arg?: T): Promise<void> {
    let script: string;
    if (typeof fnOrScript === "function") {
      script = `(${fnOrScript.toString()})(${JSON.stringify(arg)})`;
    } else {
      script = fnOrScript;
    }
    // Pre-evaluate before navigations or on current page
    await this.webview.evaluate(`window.eval(${JSON.stringify(script)})`).catch((err: unknown): void => {
      void err;
    });
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

  async selectOption(selector: string, value: string): Promise<void> {
    const found = await this.evaluate<boolean>(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el || !(el instanceof HTMLSelectElement)) return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()
    `);
    if (!found) {
      throw new Error(`Select element not found: ${selector}`);
    }
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    if (options.mask && options.mask.length > 0) {
      await this.evaluate(`
        (() => {
          for (const sel of ${JSON.stringify(options.mask)}) {
            document.querySelectorAll(sel).forEach((el) => {
              el.style.visibility = "hidden";
            });
          }
        })()
      `);
    }
    const blob = await this.webview.screenshot();
    return Buffer.from(await blob.arrayBuffer());
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
