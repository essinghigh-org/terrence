import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { WorkspaceRepositoryLink } from "../src/components/WorkspaceRepositoryLink";

afterEach((): void => {
  cleanup();
});

test("links a valid GitHub App-backed repository", () => {
  const view = render(
    <WorkspaceRepositoryLink
      repo={{ identifier: "acme/infrastructure", "github-app-installation-id": "ghain-1" }}
    />,
  );

  const link = view.getByRole("link", { name: "Open GitHub repository acme/infrastructure" });
  expect(link.getAttribute("href")).toBe("https://github.com/acme/infrastructure");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noreferrer");
});

test("does not infer a GitHub URL for provider-unknown or malformed repositories", () => {
  const view = render(
    <>
      <WorkspaceRepositoryLink repo={{ identifier: "acme/infrastructure" }} />
      <WorkspaceRepositoryLink
        repo={{ identifier: "acme/../secrets", "github-app-installation-id": "ghain-1" }}
      />
    </>,
  );

  expect(view.queryByRole("link")).toBeNull();
  expect(view.getByText("acme/infrastructure")).toBeTruthy();
  expect(view.getByText("acme/../secrets")).toBeTruthy();
});
