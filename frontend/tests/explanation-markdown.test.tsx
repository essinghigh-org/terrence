import { expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { MarkdownContent } from "../src/components/MarkdownContent";

test("renders explanation markdown without injecting HTML", () => {
  const view = render(
    <MarkdownContent markdown={"**Destroying:** `repo-a`\n\n- **Risk:** `secret`\n- <script>alert(1)</script>\n\n~~old~~"} />,
  );

  expect(view.getByText("Destroying:", { selector: "strong" })).toBeTruthy();
  expect(view.getByText("repo-a", { selector: "code" })).toBeTruthy();
  expect(view.getByText("Risk:", { selector: "strong" })).toBeTruthy();
  expect(view.getByText("<script>alert(1)</script>")).toBeTruthy();
  expect(view.getByText("old", { selector: "del" })).toBeTruthy();
  expect(view.container.querySelector("script")).toBeNull();
});