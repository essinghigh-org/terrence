/* eslint-disable @typescript-eslint/no-empty-function */
import { afterEach } from "bun:test";
import { cleanup, configure } from "@testing-library/react";
import { JSDOM } from "jsdom";

configure({ defaultHidden: true });

const jsdom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const { window } = jsdom;

global.window = window as any;
global.document = window.document;
global.navigator = { userAgent: "node.js" } as any;

Object.defineProperty(window, "confirm", {
  value: () => true,
  writable: true,
  configurable: true,
});
/* eslint-disable-next-line @typescript-eslint/no-empty-function */
const noop = (): void => {};
Object.defineProperty(window, "alert", {
  value: noop,
  writable: true,
  configurable: true,
});

(window.Element.prototype as any).attachEvent = (window.Element.prototype as any).attachEvent || function() {};
(window.Element.prototype as any).detachEvent = (window.Element.prototype as any).detachEvent || function() {};

(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Element = window.Element;
(globalThis as any).Node = window.Node;
(globalThis as any).NodeFilter = window.NodeFilter;
(globalThis as any).Event = window.Event;
(globalThis as any).CustomEvent = window.CustomEvent;
(globalThis as any).HTMLInputElement = window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = window.HTMLButtonElement;
(globalThis as any).HTMLSelectElement = window.HTMLSelectElement;
(globalThis as any).HTMLTextAreaElement = window.HTMLTextAreaElement;
(globalThis as any).HTMLAnchorElement = window.HTMLAnchorElement;
(globalThis as any).HTMLFormElement = window.HTMLFormElement;
(globalThis as any).getComputedStyle = window.getComputedStyle;
(globalThis as any).localStorage = window.localStorage;
(globalThis as any).sessionStorage = window.sessionStorage;
(globalThis as any).confirm = window.confirm;
(globalThis as any).alert = window.alert;
(globalThis as any).MutationObserver = window.MutationObserver || class {
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
};
(globalThis as any).ResizeObserver = (window as any).ResizeObserver || class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const observer = new window.MutationObserver((mutations) => {
  if (window.document?.body) {
    if (window.document.body.style.pointerEvents === "none") {
      window.document.body.style.pointerEvents = "";
    }
    if (window.document.body.hasAttribute("data-scroll-locked")) {
      window.document.body.removeAttribute("data-scroll-locked");
    }
  }
  for (const mutation of mutations) {
    if (mutation.type === "attributes" && (mutation.attributeName === "aria-hidden" || mutation.attributeName === "data-aria-hidden")) {
      const target = mutation.target as HTMLElement;
      if (target.getAttribute("aria-hidden") === "true" && target.tagName !== "BODY" && !target.closest('[role="dialog"]')) {
        target.removeAttribute("aria-hidden");
        target.removeAttribute("data-aria-hidden");
      }
    }
    if (mutation.type === "attributes" && mutation.attributeName === "data-state") {
      const target = mutation.target as HTMLElement;
      if (target.getAttribute("data-state") === "closed") {
        target.dispatchEvent(new window.Event("animationend", { bubbles: true }));
        target.dispatchEvent(new window.Event("transitionend", { bubbles: true }));
      }
    }
  }
});

if (window.document?.body) {
  observer.observe(window.document.body, { attributes: true, subtree: true, attributeFilter: ["aria-hidden", "data-aria-hidden", "data-state", "style", "data-scroll-locked"] });
}

afterEach(() => {
  cleanup();
  if (typeof localStorage !== 'undefined') localStorage.clear();
});


