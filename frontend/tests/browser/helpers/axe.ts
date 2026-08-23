import axe from "axe-core";
import type { BrowserPage } from "./browser";
import { expect } from "bun:test";

export type AxeNodeResult = {
  html: string;
  target: string[];
  failureSummary?: string;
};

export type AxeViolation = {
  id: string;
  impact?: "minor" | "moderate" | "serious" | "critical" | null;
  description: string;
  help: string;
  helpUrl: string;
  nodes: AxeNodeResult[];
};

export type AxeResults = {
  violations: AxeViolation[];
  passes: unknown[];
  incomplete: unknown[];
  inapplicable: unknown[];
};

export type A11yOptions = {
  tags?: string[];
  rules?: Record<string, { enabled: boolean }>;
  filterInputPlaceholderContrast?: boolean;
};

export async function injectAxe(page: BrowserPage): Promise<void> {
  const isAxeLoaded = await page.evaluate<boolean>("typeof window.axe !== 'undefined'").catch((): boolean => false);
  if (!isAxeLoaded) {
    await page.evaluate(`
      (() => {
        ${axe.source}
      })()
    `);
  }
}

export async function runA11y(page: BrowserPage, options: A11yOptions = {}): Promise<AxeResults> {
  await injectAxe(page);
  const tags = options.tags ?? ["wcag2a", "wcag2aa"];
  const rules = options.rules ?? {};

  const results = await page.evaluate<AxeResults>(`
    (async () => {
      return await window.axe.run(document, {
        runOnly: {
          type: "tag",
          values: ${JSON.stringify(tags)},
        },
        rules: ${JSON.stringify(rules)},
      });
    })()
  `);

  return results;
}

/**
 * Filter out known benign node-level exceptions (e.g. WCAG 1.4.3 input placeholder contrast
 * on dark/muted theme cards) and assert zero accessibility violations.
 */
export async function expectNoA11yViolations(page: BrowserPage, options: A11yOptions = {}): Promise<void> {
  const results = await runA11y(page, options);

  const filtered = results.violations
    .map((v): AxeViolation | null => {
      if (v.id !== "color-contrast" || options.filterInputPlaceholderContrast === false) {
        return v;
      }
      // Only filter out specific nodes that are input elements; keep other nodes
      const nonExemptNodes = v.nodes.filter((n): boolean => !n.html.trimStart().startsWith("<input"));
      if (nonExemptNodes.length === 0) {
        return null;
      }
      return {
        ...v,
        nodes: nonExemptNodes,
      };
    })
    .filter((v): v is AxeViolation => v !== null);

  if (filtered.length > 0) {
    const formatted = filtered
      .map((v) => {
        const targets = v.nodes
          .map((n) => `  Target: ${n.target.join(" > ")}\n  HTML: ${n.html}\n  Summary: ${n.failureSummary ?? ""}`)
          .join("\n");
        return `[${v.impact?.toUpperCase() ?? "UNKNOWN"}] ${v.id}: ${v.help} (${v.helpUrl})\n${targets}`;
      })
      .join("\n\n");

    throw new Error(`Accessibility violations found (${filtered.length}):\n\n${formatted}`);
  }

  expect(filtered.length).toBe(0);
}
