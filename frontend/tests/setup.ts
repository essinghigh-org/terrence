import { afterEach } from "bun:test";
import { cleanup, configure } from "@testing-library/react";
import { JSDOM } from "jsdom";

configure({ defaultHidden: true });

const jsdom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const win = jsdom.window;

type MutableGlobal = Record<string, unknown>;

(globalThis as MutableGlobal)["window"] = win;
(globalThis as MutableGlobal)["document"] = win.document;
(globalThis as MutableGlobal)["navigator"] = { userAgent: "node.js" };

Object.defineProperty(win, "confirm", {
  value: (): boolean => true,
  writable: true,
  configurable: true,
});

const noop = (): void => {
  // Intentional noop for testing environment alert mock
};

// jsdom does not implement PointerEvent, but base-ui checkbox click handlers
// dispatch a synthetic PointerEvent at the hidden input. Real browsers all
// ship PointerEvent, so mirror the spec surface here.
if (win.PointerEvent === undefined) {
  class PointerEventPolyfill extends win.MouseEvent {
    public readonly pointerId: number;
    public readonly pointerType: string;
    public readonly isPrimary: boolean;
    public readonly width: number;
    public readonly height: number;
    public readonly pressure: number;
    public readonly tangentialPressure: number;
    public readonly tiltX: number;
    public readonly tiltY: number;
    public readonly twist: number;

    public constructor(type: string, eventInitDict: PointerEventInit = {}) {
      super(type, eventInitDict);
      this.pointerId = eventInitDict.pointerId ?? 0;
      this.pointerType = eventInitDict.pointerType ?? "";
      this.isPrimary = eventInitDict.isPrimary ?? false;
      this.width = eventInitDict.width ?? 1;
      this.height = eventInitDict.height ?? 1;
      this.pressure = eventInitDict.pressure ?? 0;
      this.tangentialPressure = eventInitDict.tangentialPressure ?? 0;
      this.tiltX = eventInitDict.tiltX ?? 0;
      this.tiltY = eventInitDict.tiltY ?? 0;
      this.twist = eventInitDict.twist ?? 0;
    }
  }
  (win as unknown as Record<string, unknown>)["PointerEvent"] = PointerEventPolyfill;
  (globalThis as MutableGlobal)["PointerEvent"] = PointerEventPolyfill;
}

Object.defineProperty(win, "alert", {
  value: noop,
  writable: true,
  configurable: true,
});

const elemProto = win.Element.prototype as unknown as Record<string, unknown>;
elemProto["attachEvent"] = elemProto["attachEvent"] ?? noop;
elemProto["detachEvent"] = elemProto["detachEvent"] ?? noop;
elemProto["scrollIntoView"] = elemProto["scrollIntoView"] ?? noop;

(globalThis as MutableGlobal)["HTMLElement"] = win.HTMLElement;
(globalThis as MutableGlobal)["Element"] = win.Element;
(globalThis as MutableGlobal)["Node"] = win.Node;
(globalThis as MutableGlobal)["NodeFilter"] = win.NodeFilter;
(globalThis as MutableGlobal)["Event"] = win.Event;
(globalThis as MutableGlobal)["CustomEvent"] = win.CustomEvent;
(globalThis as MutableGlobal)["HTMLInputElement"] = win.HTMLInputElement;
(globalThis as MutableGlobal)["HTMLButtonElement"] = win.HTMLButtonElement;
(globalThis as MutableGlobal)["HTMLSelectElement"] = win.HTMLSelectElement;
(globalThis as MutableGlobal)["HTMLTextAreaElement"] = win.HTMLTextAreaElement;
(globalThis as MutableGlobal)["HTMLAnchorElement"] = win.HTMLAnchorElement;
(globalThis as MutableGlobal)["HTMLFormElement"] = win.HTMLFormElement;
(globalThis as MutableGlobal)["getComputedStyle"] = win.getComputedStyle;
(globalThis as MutableGlobal)["localStorage"] = win.localStorage;
(globalThis as MutableGlobal)["sessionStorage"] = win.sessionStorage;
(globalThis as MutableGlobal)["confirm"] = win.confirm;
(globalThis as MutableGlobal)["alert"] = win.alert;
(globalThis as MutableGlobal)["requestAnimationFrame"] = (callback: FrameRequestCallback): number =>
  win.setTimeout((): void => callback(Date.now()), 0);
(globalThis as MutableGlobal)["cancelAnimationFrame"] = (handle: number): void => {
  win.clearTimeout(handle);
};

class DummyMutationObserver {
  public observe(): void {
    // No-op for tests fallback
  }
  public disconnect(): void {
    // No-op for tests fallback
  }
  public takeRecords(): MutationRecord[] {
    return [];
  }
}

class DummyResizeObserver {
  public observe(): void {
    // No-op for tests fallback
  }
  public unobserve(): void {
    // No-op for tests fallback
  }
  public disconnect(): void {
    // No-op for tests fallback
  }
}

(globalThis as MutableGlobal)["MutationObserver"] = win.MutationObserver ?? DummyMutationObserver;
(globalThis as MutableGlobal)["ResizeObserver"] = (win as unknown as Record<string, unknown>)["ResizeObserver"] ?? DummyResizeObserver;

type ReadonlyMutations = readonly MutationRecord[];

const observer = new win.MutationObserver((mutations: ReadonlyMutations): void => {
  const doc = win.document;
  if (doc.body !== null && doc.body !== undefined) {
    if (doc.body.style.pointerEvents === "none") {
      doc.body.style.pointerEvents = "";
    }
    if (doc.body.hasAttribute("data-scroll-locked")) {
      doc.body.removeAttribute("data-scroll-locked");
    }
  }
  for (const mutation of mutations) {
    if (mutation.type === "attributes" && (mutation.attributeName === "aria-hidden" || mutation.attributeName === "data-aria-hidden")) {
      const target = mutation.target as HTMLElement;
      if (target.getAttribute("aria-hidden") === "true" && target.tagName !== "BODY" && target.closest('[role="dialog"]') === null) {
        target.removeAttribute("aria-hidden");
        target.removeAttribute("data-aria-hidden");
      }
    }
    if (mutation.type === "attributes" && mutation.attributeName === "data-state") {
      const target = mutation.target as HTMLElement;
      if (target.getAttribute("data-state") === "closed") {
        target.dispatchEvent(new win.Event("animationend", { bubbles: true }));
        target.dispatchEvent(new win.Event("transitionend", { bubbles: true }));
      }
    }
  }
});

if (win.document.body !== null && win.document.body !== undefined) {
  observer.observe(win.document.body, { attributes: true, subtree: true, attributeFilter: ["aria-hidden", "data-aria-hidden", "data-state", "style", "data-scroll-locked"] });
}

afterEach((): void => {
  cleanup();
  if (typeof localStorage !== "undefined") localStorage.clear();
});
