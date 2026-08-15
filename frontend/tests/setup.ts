import { afterEach } from "bun:test";
import { cleanup, configure } from "@testing-library/react";
import { JSDOM } from "jsdom";
import type { JsonObject } from "../src/lib/json";

configure({ defaultHidden: true });

const jsdom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const win = jsdom.window;

type MutableGlobal = JsonObject;

// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["window"] = win;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["document"] = win.document;
// SAFETY: the test stubs the global with a mock before exercising the component.
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
  // SAFETY: jsdom lacks PointerEvent at runtime; the polyfill mirrors the spec
  // surface above and is injected before any component renders.
  Object.defineProperty(win, "PointerEvent", {
    value: PointerEventPolyfill,
    writable: true,
    configurable: true,
  });
// SAFETY: the test stubs the global with a mock before exercising the component.
  (globalThis as MutableGlobal)["PointerEvent"] = PointerEventPolyfill;
}

Object.defineProperty(win, "alert", {
  value: noop,
  writable: true,
  configurable: true,
});

// SAFETY: legacy IE-only methods are injected onto the jsdom Element prototype;
// the intersection adds an index signature for the test-only polyfills below.
const elemProto = win.Element.prototype as Element & JsonObject;
elemProto["attachEvent"] = elemProto["attachEvent"] ?? noop;
elemProto["detachEvent"] = elemProto["detachEvent"] ?? noop;
elemProto["scrollIntoView"] = elemProto["scrollIntoView"] ?? noop;

// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["HTMLElement"] = win.HTMLElement;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["Element"] = win.Element;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["Node"] = win.Node;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["NodeFilter"] = win.NodeFilter;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["Event"] = win.Event;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["CustomEvent"] = win.CustomEvent;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["HTMLInputElement"] = win.HTMLInputElement;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["HTMLButtonElement"] = win.HTMLButtonElement;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["HTMLSelectElement"] = win.HTMLSelectElement;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["HTMLTextAreaElement"] = win.HTMLTextAreaElement;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["HTMLAnchorElement"] = win.HTMLAnchorElement;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["HTMLFormElement"] = win.HTMLFormElement;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["getComputedStyle"] = win.getComputedStyle;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["localStorage"] = win.localStorage;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["sessionStorage"] = win.sessionStorage;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["confirm"] = win.confirm;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["alert"] = win.alert;
// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["requestAnimationFrame"] = (callback: FrameRequestCallback): number =>
  win.setTimeout((): void => callback(Date.now()), 0);
// SAFETY: the test stubs the global with a mock before exercising the component.
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

// SAFETY: the test stubs the global with a mock before exercising the component.
(globalThis as MutableGlobal)["MutationObserver"] = win.MutationObserver ?? DummyMutationObserver;
// SAFETY: jsdom may lack ResizeObserver at runtime; the dummy keeps tests
// that observe elements from crashing when the browser would provide one.
Object.defineProperty(win, "ResizeObserver", {
  value: (win as Window & JsonObject)["ResizeObserver"] ?? DummyResizeObserver,
  writable: true,
  configurable: true,
});

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
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
      const target = mutation.target as HTMLElement;
      if (target.getAttribute("aria-hidden") === "true" && target.tagName !== "BODY" && target.closest('[role="dialog"]') === null) {
        target.removeAttribute("aria-hidden");
        target.removeAttribute("data-aria-hidden");
      }
    }
    if (mutation.type === "attributes" && mutation.attributeName === "data-state") {
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
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
  if (localStorage !== undefined) localStorage.clear();
});