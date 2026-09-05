import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { RunLogOutput } from "../src/components/RunLogOutput";

afterEach(cleanup);

test("live logs follow smoothly, pause on upward scrolling, and respect reduced motion", () => {
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  let reduced = false;
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: reduced }) });
  try {
    const view = render(<RunLogOutput active={false} className="">first</RunLogOutput>);
    const pane = view.getByText("first");
    const calls: ScrollToOptions[] = [];
    Object.defineProperties(pane, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 1000, configurable: true },
      scrollTo: { value: (options: ScrollToOptions) => { calls.push(options); } },
    });
    view.rerender(<RunLogOutput active className="">first</RunLogOutput>);
    expect(calls.at(-1)).toEqual({ top: 1000, behavior: "instant" });
    pane.scrollTop = 900;
    fireEvent.scroll(pane);
    Object.defineProperty(pane, "scrollHeight", { value: 1100 });
    view.rerender(<RunLogOutput active className="">second</RunLogOutput>);
    expect(calls.at(-1)).toEqual({ top: 1100, behavior: "smooth" });
    // Intermediate events from a smooth downward scroll must not disable following.
    pane.scrollTop = 940;
    fireEvent.scroll(pane);
    view.rerender(<RunLogOutput active className="">third</RunLogOutput>);
    expect(calls).toHaveLength(3);
    pane.scrollTop = 500;
    fireEvent.scroll(pane);
    view.rerender(<RunLogOutput active className="">fourth</RunLogOutput>);
    expect(calls).toHaveLength(3);
    pane.scrollTop = 1000;
    fireEvent.scroll(pane);
    reduced = true;
    view.rerender(<RunLogOutput active={false} className="">finished</RunLogOutput>);
    expect(calls.at(-1)).toEqual({ top: 1100, behavior: "instant" });
    expect(calls).toHaveLength(4);
  } finally {
    if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
    else Reflect.deleteProperty(window, "matchMedia");
  }
});
