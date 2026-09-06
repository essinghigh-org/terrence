import { expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Terrence } from "../src/components/brand/Terrence";

const poses = ["welcome", "empty", "healthy", "failed", "lost", "maintenance", "guide", "blocked", "interrupted"] as const;

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
    ["healthy", undefined],
    ["failed", undefined],
    ["lost", "map"],
    ["maintenance", "wrench"],
    ["guide", "book"],
    ["blocked", "gate"],
    ["interrupted", "cable"],
  ] as const);

  for (const [pose, prop] of requiredProps) {
    const view = render(<Terrence pose={pose} detail="small" />);
    const svg = view.container.querySelector("svg");
    if (prop !== undefined) expect(svg?.querySelector(`[data-prop="${prop}"]`)).not.toBeNull();
    if (pose === "healthy") expect(svg?.querySelector("path[d^=\"m209 213\"]")).not.toBeNull();
    if (pose === "failed") expect(svg?.querySelector("path[d^=\"m151 211\"]")).not.toBeNull();
  }
});

test("held props get a foreground hand layer and healthy settles its posture", (): void => {
  for (const [pose, prop] of [["empty", "box"], ["lost", "map"], ["maintenance", "wrench"], ["guide", "book"]] as const) {
    const svg = render(<Terrence pose={pose} />).container.querySelector("svg");
    expect(svg?.querySelector(`[data-prop=\"${prop}\"]`)).not.toBeNull();
    expect(svg?.querySelector(`[data-held-prop=\"${prop}\"]`)).not.toBeNull();
    expect(svg?.querySelector(".terrence-foreground-hand")).not.toBeNull();
    expect(svg?.getAttribute("data-surface")).toBe("paper");
  }

  const welcome = render(<Terrence pose="welcome" surface="transparent" />).container.querySelector("svg");
  const healthy = render(<Terrence pose="healthy" surface="transparent" />).container.querySelector("svg");
  expect(welcome?.querySelector(".terrence-wave")).not.toBeNull();
  expect(healthy?.querySelector(".terrence-wave")).toBeNull();
  expect(healthy?.querySelector('[data-arm-role="settled"]')).not.toBeNull();
  expect(healthy?.querySelector('[data-prop="check"]')).not.toBeNull();
});

test("blocked and interrupted stay neutral, distinct, and opt into a dark-surface backplate", (): void => {
  const blocked = render(<Terrence pose="blocked" surface="transparent" />).container.querySelector("svg");
  const interrupted = render(<Terrence pose="interrupted" surface="paper" />).container.querySelector("svg");
  expect(blocked?.querySelector('[data-prop="gate"]')).not.toBeNull();
  expect(blocked?.querySelector('path[d="M151 171h20"]')).not.toBeNull();
  expect(blocked?.querySelector(".terrence-backplate")).toBeNull();
  expect(interrupted?.querySelector('[data-prop="cable"]')).not.toBeNull();
  expect(interrupted?.querySelector(".terrence-backplate")).not.toBeNull();
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
