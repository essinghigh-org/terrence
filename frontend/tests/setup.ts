import { afterEach } from "bun:test";
import { cleanup } from "@testing-library/react";
import { JSDOM } from "jsdom";

const jsdom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const { window } = jsdom;

global.window = window as any;
global.document = window.document;
global.navigator = { userAgent: "node.js" } as any;

afterEach(() => {
  cleanup();
  if (typeof localStorage !== 'undefined') localStorage.clear();
});
