import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Accessibility automated tests (kanban 22.14).
 *
 * Structural WCAG invariants that hold regardless of data or visual design:
 *   - exactly one <main> landmark per page
 *   - every <button> has an accessible name (text, aria-label, or aria-labelledby)
 *   - every <a> has an accessible name
 *   - every <img> carries alt text or is explicitly decorative
 *   - every form control has an associated <label>, aria-label, or
 *     aria-labelledby
 *   - no element marked aria-hidden contains focusable content
 *
 * Run from the frontend directory:
 *   npx playwright test tests/e2e/accessibility.test.ts
 */
/**
 * Test-box admin token. Prefer TERRENCE_E2E_ADMIN_TOKEN from the
 * environment; the fallback mirrors the value already committed in
 * run-detail.test.ts — a local sandbox-only credential for the test
 * instance on 127.0.0.1:3001, never a production secret.
 */
const ADMIN_TOKEN = process.env.TERRENCE_E2E_ADMIN_TOKEN ?? "terrence-test-pVhq8jdDKeWxwGCotTEMRNdnwsjpg9RU";
const RUN_ID = "423b4c6e-3b0b-4707-94c6-678d80c43f09";

/** Collect structural a11y violations from the rendered DOM. */
async function collectViolations(page: Page): Promise<string[]> {
  return page.evaluate((): string[] => {
    const issues: string[] = [];
    const main = document.querySelectorAll("main");
    if (main.length !== 1) {
      issues.push(`expected exactly one <main> landmark, found ${main.length}`);
    }

    const accessibleName = (el: Element): string => {
      // aria-labelledby wins over aria-label per the accname algorithm;
      // resolve each referenced id in order, joining trimmed text.
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const resolved = labelledBy.split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .filter((text) => text !== "")
          .join(" ")
          .trim();
        if (resolved !== "") return resolved;
      }
      return el.getAttribute("aria-label")?.trim() ?? "";
    };

    for (const btn of document.querySelectorAll("button")) {
      if (btn.getAttribute("aria-hidden") !== null) continue;
      if (!(btn.textContent?.trim() || accessibleName(btn))) {
        issues.push(`button without accessible name: ${btn.outerHTML.slice(0, 100)}`);
      }
    }

    for (const a of document.querySelectorAll("a")) {
      if (a.getAttribute("aria-hidden") !== null) continue;
      const name = a.textContent?.trim() || accessibleName(a) || a.getAttribute("title")?.trim();
      if (!name) {
        issues.push(`link without accessible name: ${a.outerHTML.slice(0, 100)}`);
      }
    }

    for (const img of document.querySelectorAll("img")) {
      if (img.getAttribute("aria-hidden") !== null) continue;
      if (!img.hasAttribute("alt") && !img.getAttribute("aria-label")) {
        issues.push(`img without alt text: ${img.outerHTML.slice(0, 100)}`);
      }
    }

    for (const el of document.querySelectorAll("input, select, textarea")) {
// SAFETY: the component renders this element type for the queried role/label.
      const input = el as HTMLInputElement;
      if (input.type === "hidden") continue;
      if (el.getAttribute("aria-hidden") !== null) continue;
      const label = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
      const labelledBy = el.getAttribute("aria-labelledby");
      const ariaLabel = el.getAttribute("aria-label");
      const wrapped = el.closest("label") !== null;
      if (!label && !wrapped && !ariaLabel && !labelledBy && !el.getAttribute("title")) {
        issues.push(`control without label: <${el.tagName.toLowerCase()} id="${el.id}" name="${el.getAttribute("name") ?? ""}">`);
      }
    }

    // aria-hidden containers must not trap focusable content
    for (const hidden of document.querySelectorAll('[aria-hidden="true"]')) {
      if (hidden.querySelector("button, a[href], input, select, textarea, [tabindex]")) {
        issues.push(`aria-hidden container contains focusable content: ${hidden.outerHTML.slice(0, 100)}`);
      }
    }

    return issues;
  });
}

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.evaluate((token: string): void => {
    localStorage.setItem("tfe_token", token);
    localStorage.setItem("tfe_refreshable_session", "true");
  }, ADMIN_TOKEN);
});

test("login page satisfies structural accessibility invariants", async ({ page }: { page: Page }): Promise<void> => {
  await page.goto("/login", { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForTimeout(1000);
  const violations = await collectViolations(page);
  expect(violations, violations.join("\n")).toEqual([]);
});

test("workspace page satisfies structural accessibility invariants", async ({ page }: { page: Page }): Promise<void> => {
  await page.goto("/app/essinghigh-org/workspaces/tf-deploy-github-repository", {
    waitUntil: "networkidle",
    timeout: 15000,
  });
  await page.waitForTimeout(2000);
  const violations = await collectViolations(page);
  expect(violations, violations.join("\n")).toEqual([]);
});

test("run detail page satisfies structural accessibility invariants", async ({ page }: { page: Page }): Promise<void> => {
  await page.goto(
    `/app/essinghigh-org/workspaces/tf-deploy-github-repository/runs/${RUN_ID}`,
    { waitUntil: "networkidle", timeout: 15000 },
  );
  await page.waitForTimeout(2000);
  const violations = await collectViolations(page);
  expect(violations, violations.join("\n")).toEqual([]);
});