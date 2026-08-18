import { expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { MarkdownContent } from "../src/components/MarkdownContent";

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
