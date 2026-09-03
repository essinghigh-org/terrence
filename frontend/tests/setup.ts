import { afterEach, mock } from "bun:test";
import { orgPermissionsCache } from "../src/hooks/useOrganizationPermissions";
import { cleanup, configure } from "@testing-library/react";
import { JSDOM } from "jsdom";

configure({
  defaultHidden: true,
  // CI runners (2 vCPU) run --parallel=8 workers; under CPU starvation the
  // default 1s async-util timeout expires before React flushes a render.
  asyncUtilTimeout: 10_000,
});

const jsdom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
let customLocation: unknown;
const win = new Proxy(jsdom.window, {
  get(target, prop, receiver) {
    if (prop === "location" && customLocation !== undefined) return customLocation;
    return Reflect.get(target, prop, receiver);
  },
  set(target, prop, value, receiver) {
    if (prop === "location") {
      customLocation = value;
      return true;
    }
    return Reflect.set(target, prop, value, receiver);
  },
});

// Writable test-only view of the global (JsonObject is readonly JSON and cannot
// hold constructors or functions, which is all this preload installs).
type MutableGlobal = Record<string, unknown>;
const testGlobal = globalThis as unknown as MutableGlobal;

// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["window"] = win;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["document"] = win.document;
// jsdom starts hidden; application polling tests must opt into hidden state
// explicitly so test behavior does not depend on another file's teardown.
Object.defineProperty(win.document, "hidden", {
  configurable: true,
  value: false,
});
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["navigator"] = { userAgent: "node.js" };

Object.defineProperty(jsdom.window, "confirm", {
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
if (win["PointerEvent"] === undefined) {
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
  testGlobal["PointerEvent"] = PointerEventPolyfill;
}

Object.defineProperty(win, "alert", {
  value: noop,
  writable: true,
  configurable: true,
});

// SAFETY: legacy IE-only methods are injected onto the jsdom Element prototype;
// the intersection adds an index signature for the test-only polyfills below.
const elemProto = win.Element.prototype as Element & Record<string, unknown>;
elemProto["attachEvent"] = elemProto["attachEvent"] ?? noop;
elemProto["detachEvent"] = elemProto["detachEvent"] ?? noop;
elemProto["scrollIntoView"] = elemProto["scrollIntoView"] ?? noop;

// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["HTMLElement"] = win.HTMLElement;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["Element"] = win.Element;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["Node"] = win.Node;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["NodeFilter"] = win.NodeFilter;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["Event"] = win.Event;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["CustomEvent"] = win.CustomEvent;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["HTMLInputElement"] = win.HTMLInputElement;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["HTMLButtonElement"] = win.HTMLButtonElement;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["HTMLSelectElement"] = win.HTMLSelectElement;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["HTMLTextAreaElement"] = win.HTMLTextAreaElement;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["HTMLAnchorElement"] = win.HTMLAnchorElement;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["HTMLFormElement"] = win.HTMLFormElement;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["getComputedStyle"] = win.getComputedStyle;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["localStorage"] = win.localStorage;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["sessionStorage"] = win.sessionStorage;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["confirm"] = win.confirm;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["alert"] = win.alert;
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["requestAnimationFrame"] = (callback: FrameRequestCallback): number =>
  win.setTimeout((): void => callback(Date.now()), 0);
// SAFETY: the test stubs the global with a mock before exercising the component.
testGlobal["cancelAnimationFrame"] = (handle: number): void => {
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
testGlobal["MutationObserver"] = win.MutationObserver ?? DummyMutationObserver;
// SAFETY: jsdom may lack ResizeObserver at runtime; the dummy keeps tests
// that observe elements from crashing when the browser would provide one.
testGlobal["ResizeObserver"] = win["ResizeObserver"] ?? DummyResizeObserver;
Object.defineProperty(win, "ResizeObserver", {
  value: win["ResizeObserver"] ?? DummyResizeObserver,
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
  // Bun >=1.0.9 mock.restore(): restores every mock/spy created with the
  // bun:test mock API without per-file bookkeeping.
  mock.restore();
  customLocation = undefined;
  if (localStorage !== undefined) localStorage.clear();
  orgPermissionsCache.clear();
});