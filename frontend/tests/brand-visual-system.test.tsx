import { expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Terrence } from "../src/components/brand/Terrence";

const poses = ["welcome", "empty", "healthy", "failed", "lost", "maintenance", "guide", "blocked", "interrupted", "ecosystem"] as const;

test("Terrence exposes one explicit small detail tier for every canonical pose", (): void => {
  for (const pose of poses) {
    const full = render(<Terrence pose={pose} />);
    const fullSvg = full.container.querySelector("svg");
    expect(fullSvg?.getAttribute("data-pose")).toBe(pose);
    expect(fullSvg?.getAttribute("data-detail")).toBe("full");
    expect(fullSvg?.querySelector(".terrence-secondary-detail")).not.toBeNull();

    const small = render(<Terrence pose={pose} detail="small" />);
    const smallSvg = small.container.querySelector("svg");
    expect(smallSvg?.getAttribute("data-pose")).toBe(pose);
    expect(smallSvg?.getAttribute("data-detail")).toBe("small");
    expect(smallSvg?.querySelector(".terrence-secondary-detail")).toBeNull();
    expect(smallSvg?.getAttribute("viewBox")).toBe("0 0 320 280");
  }
});

test("the small tier keeps essential prop geometry", (): void => {
  const requiredProps = new Map([
    ["empty", "box"],
    ["healthy", "check"],
    ["failed", "diagnostic"],
    ["lost", "map"],
    ["maintenance", "wrench"],
    ["guide", "book"],
    ["blocked", "lock"],
    ["interrupted", "cable"],
  ] as const);

  for (const [pose, prop] of requiredProps) {
    const view = render(<Terrence pose={pose} detail="small" />);
    const svg = view.container.querySelector("svg");
    expect(svg?.querySelector(`[data-prop="${prop}"]`)).not.toBeNull();
    expect(svg?.querySelector(".terrence-paw")).not.toBeNull();
  }
});

test("engine marks float independently of the character without tiles or grips", (): void => {
  const svg = render(<Terrence pose="ecosystem" />).container.querySelector("svg");
  const marks = svg?.querySelector('[data-prop="engine-marks"]');
  expect(marks).not.toBeNull();
  expect(marks?.querySelectorAll("g > svg > svg").length).toBe(2);
  expect(marks?.closest(".terrence-body")).toBeNull();
  expect(marks?.querySelector("rect, .terrence-paw")).toBeNull();
  expect(svg?.querySelector(".terrence-orbit--back")).not.toBeNull();
  expect(marks?.querySelector(".terrence-orbit--front")).not.toBeNull();
  const layers = [...(svg?.children ?? [])];
  expect(layers.findIndex((layer): boolean => layer === marks))
    .toBeGreaterThan(layers.findIndex((layer): boolean => layer.classList.contains("terrence-body")));
});

test("illustrations blend into their surrounding surface by default", (): void => {
  for (const pose of poses) {
    const svg = render(<Terrence pose={pose} />).container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
    expect(svg?.querySelector(".terrence-backplate")).toBeNull();
  }
});

test("blocked and interrupted stay neutral, distinct, and opt into a dark-surface backplate", (): void => {
  const blocked = render(<Terrence pose="blocked" surface="transparent" />).container.querySelector("svg");
  const interrupted = render(<Terrence pose="interrupted" surface="paper" />).container.querySelector("svg");
  expect(blocked?.querySelector('[data-prop="lock"]')).not.toBeNull();
  expect(blocked?.querySelector(".terrence-backplate")).toBeNull();
  expect(interrupted?.querySelector('[data-prop="cable"]')).not.toBeNull();
  expect(interrupted?.querySelector(".terrence-backplate")).not.toBeNull();
});

test("every illustration stays self-contained vector art with flat fills", (): void => {
  for (const pose of poses) {
    const svg = render(<Terrence pose={pose} />).container.querySelector("svg");
    expect(svg?.querySelector("image, foreignObject, script, filter, linearGradient, radialGradient, use")).toBeNull();
    expect(svg?.querySelector(".terrence-ear-left")).not.toBeNull();
    expect(svg?.querySelector(".terrence-ear-right")).not.toBeNull();
    expect(svg?.querySelector(".terrence-face")).not.toBeNull();
    expect(svg?.querySelectorAll("[id]").length).toBe(0);
  }
});

test("the generated gallery is a deterministic real-size regression sheet", (): void => {
  const gallery = readFileSync(join(import.meta.dir, "../public/brand/index.html"), "utf8");
  expect(gallery).toContain('data-pose="blocked"');
  expect(gallery).toContain('data-pose="interrupted"');
  expect(gallery).toContain("size-96");
  expect(gallery).toContain("size-128");
  expect(gallery).toContain("size-176");
  expect(gallery).toContain("surface-dark");
  expect(gallery).toContain("prefers-reduced-motion:reduce");
  expect(gallery).toContain("long adjacent explanation text");
  expect(gallery).toContain('aria-labelledby="logo-fixtures-title"');
});
