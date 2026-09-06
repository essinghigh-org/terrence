import { afterEach, expect, mock, test } from "bun:test";
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

test("operational log controls expose phase navigation, search counts, safe download, and pause state", () => {
  const phaseChange = mock((_phase: "plan" | "apply"): void => undefined);
  const toggleWrap = mock((): void => undefined);
  const view = render(
    <RunLogOutput
      active
      className=""
      phase="plan"
      logUrl="https://terrence.test/api/v2/runs/run-1/plan/log/token"
      onPhaseChange={phaseChange}
      onToggleWrap={toggleWrap}
    >
      {"INFO ready\nERROR failed\n"}
    </RunLogOutput>,
  );

  expect(view.getByRole("toolbar", { name: "Plan log controls" })).toBeTruthy();
  fireEvent.change(view.getByRole("combobox", { name: "Log phase" }), { target: { value: "apply" } });
  expect(phaseChange).toHaveBeenCalledWith("apply");
  fireEvent.input(view.getByRole("searchbox", { name: "Search loaded log output" }), { target: { value: "error" } });
  expect(view.getByText("1 match")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Pause following log" }));
  expect(view.getByRole("button", { name: "Follow log output" })).toBeTruthy();
  expect(view.getByRole("link", { name: "Download raw log" }).getAttribute("href")).toContain("https://terrence.test");
  expect(view.getByRole("link", { name: "Download raw log" }).getAttribute("title")).toContain("may contain secrets");
  expect(view.getByText("May contain secrets")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: /Wrap/ }));
  expect(toggleWrap).toHaveBeenCalledTimes(1);
});
