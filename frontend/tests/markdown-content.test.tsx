import { expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { MARKDOWN_PARSER_LIMITS, MarkdownContent, MarkdownParseError, parseMarkdown } from "../src/components/MarkdownContent";

test("renders tables from pipe-delimited markdown", () => {
  const view = render(
    <MarkdownContent markdown={"| Status | Meaning |\n|---|---|\n| `pending` | Waiting |\n| `applied` | Done |"} />,
  );

  expect(view.getByText("Status", { selector: "th" })).toBeTruthy();
  expect(view.getByText("Meaning", { selector: "th" })).toBeTruthy();
  expect(view.getByText("pending", { selector: "code" })).toBeTruthy();
  expect(view.getByText("Waiting")).toBeTruthy();
  expect(view.getByText("applied", { selector: "code" })).toBeTruthy();
  expect(view.getByText("Done")).toBeTruthy();
});

test("renders ordered lists", () => {
  const view = render(<MarkdownContent markdown={"1. First\n2. Second\n3. Third"} />);

  const list = view.container.querySelector("ol");
  expect(list).not.toBeNull();
  expect(list?.querySelectorAll("li").length).toBe(3);
  expect(view.getByText("First")).toBeTruthy();
  expect(view.getByText("Third")).toBeTruthy();
});

test("renders nested list children", () => {
  const view = render(<MarkdownContent markdown={"- Parent\n  - Child one\n  - Child two\n- Other"} />);

  const nestedLists = view.container.querySelectorAll("ul ul");
  expect(nestedLists.length).toBe(1);
  expect(nestedLists[0]?.querySelectorAll("li").length).toBe(2);
  expect(view.getByText("Child one")).toBeTruthy();
});

test("renders multi-line blockquotes as one quote", () => {
  const view = render(<MarkdownContent markdown={"> First line\n> Second line"} />);

  expect(view.getByText("First line Second line", { selector: "blockquote" })).toBeTruthy();
});

test("renders h4 headings", () => {
  const view = render(<MarkdownContent markdown={"#### Subsection"} />);

  expect(view.getByText("Subsection", { selector: "h4" })).toBeTruthy();
});

test("renders bare-relative doc links as anchors and blocks dangerous schemes", () => {
  const view = render(
    <MarkdownContent markdown={"See [Runs](runs) or [the overview](./overview). [Bad](javascript:alert) stays text."} />,
  );

  const runs = view.getByText("Runs");
  expect(runs.tagName).toBe("A");
  expect(runs.getAttribute("href")).toBe("runs");
  const overview = view.getByText("the overview");
  expect(overview.getAttribute("href")).toBe("./overview");
  // The dangerous scheme renders as plain text inside the paragraph.
  expect(view.container.textContent).toContain("Bad");
  expect(view.container.querySelector("a[href^='javascript']")).toBeNull();
});


test("renders malformed and streamed table prefixes without hanging", () => {
  const malformed = "| not followed by a table separator";
  const view = render(<MarkdownContent markdown={malformed} />);
  expect(view.container.textContent).toBe(malformed);
  const document = "Paragraph\n| Header | Value |\n|---|---|\n| one | two |\n\n```hcl\nvalue = 1\n```";
  for (let end = 0; end <= document.length; end += 1) {
    view.rerender(<MarkdownContent markdown={document.slice(0, end)} />);
  }
  expect(view.container.querySelector("table")).not.toBeNull();
});

test("every deterministic truncated prefix parses or returns a typed failure", () => {
  const source = "# heading\n\n```hcl\nvariable \\\"x\\\" {\n  type = string\n}\n```\n\n- item";
  for (let end = 0; end <= source.length; end += 1) {
    expect(() => parseMarkdown(source.slice(0, end))).not.toThrow();
  }
  expect(() => parseMarkdown("x".repeat(MARKDOWN_PARSER_LIMITS.maxSourceCharacters + 1)))
    .toThrow(MarkdownParseError);
  const manyBlocks = Array.from({ length: MARKDOWN_PARSER_LIMITS.maxBlocks + 1 }, () => "x").join("\n\n");
  expect(() => parseMarkdown(manyBlocks)).toThrow(MarkdownParseError);
  const view = render(<MarkdownContent markdown={"x".repeat(MARKDOWN_PARSER_LIMITS.maxSourceCharacters + 1)} />);
  expect(view.getByText("This document is too large to display.")).toBeDefined();
});

test("seeded markdown prefixes preserve parser progress and output bounds", () => {
  const seeds = [
    "# heading\n\n```hcl\nvariable \"x\" {\n  type = string\n}\n```\n\n- item",
    "| name | value |\n|---|---|\n| one | **two** |\n> quote\n",
  ];
  let randomState = 0x753;
  const random = (): number => {
    randomState = (randomState + 0x6d2b79f5) >>> 0;
    let t = randomState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const cases = Number.parseInt(process.env["TERRENCE_PROPERTY_CASES"] ?? "256", 10);
  const count = Number.isSafeInteger(cases) && cases > 0 && cases <= 10_000 ? cases : 256;
  const started = performance.now();
  for (const seed of seeds) {
    for (let index = 0; index < count; index += 1) {
      const prefix = seed.slice(0, Math.floor(random() * (seed.length + 1)));
      const blocks = parseMarkdown(prefix);
      expect(blocks.length).toBeLessThanOrEqual(MARKDOWN_PARSER_LIMITS.maxBlocks);
    }
  }
  expect(performance.now() - started).toBeLessThan(15_000);
});
