import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PolicySetDetail } from "../src/views/PolicySetDetail";

const originalFetch = globalThis.fetch;
afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function fixture(kind: string, logic: "any" | "all" | null = "any", canManage = true, failPatch = false): string[] {
  const patches: string[] = [];
  let matchingLogic = logic;
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let data: unknown = [];
    if (url === "/api/v2/policy-sets/ps-1/tag-selectors" && init?.method === "POST") {
      if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
      patches.push(init.body);
    }
    if (url === "/api/v2/organizations/acme") {
      data = { attributes: { permissions: { "can-manage-policies": canManage } } };
    } else if (url === "/api/v2/policy-sets/ps-1") {
      if (init?.method === "PATCH") {
        if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
        patches.push(init.body);
        if (failPatch)
          return new Response(JSON.stringify({ errors: [{ detail: "Update rejected" }] }), {
            status: 422,
            headers: { "Content-Type": "application/vnd.api+json" },
          });
        const body = JSON.parse(init.body) as {
          data: { attributes: { "tag-selector-matching-logic": "any" | "all" | null } };
        };
        matchingLogic = body.data.attributes["tag-selector-matching-logic"];
      }
      data = {
        id: "ps-1",
        attributes: {
          name: "Guardrails",
          kind,
          "policy-tool-version": "1.17.0",
          "tag-selector-matching-logic": matchingLogic,
          "tag-selectors": [{ "tag-key": "production", "tag-value": null, "is-exclude": false }],
        },
      };
    }
    return new Response(JSON.stringify({ data }), {
      headers: { "Content-Type": "application/vnd.api+json" },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return patches;
}

function page(section: "policies" | "tags" = "policies"): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/app/acme/policy-sets/ps-1"]}>
      <Routes>
        <Route path="/app/:orgName/policy-sets/:policySetId" element={<PolicySetDetail section={section} />} />
      </Routes>
    </MemoryRouter>,
  );
}

test("tfpolicy keeps its identity and cannot open the Sentinel editor", async () => {
  fixture("tfpolicy");
  const view = page();
  await view.findByText("Terraform policy execution is not supported");
  expect(view.getByText("TFPOLICY")).toBeTruthy();
  expect(view.getByText("Configured version: 1.17.0")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Add policy" })).toBeNull();
  expect(view.queryByText(/Sentinel policies checked/)).toBeNull();
});

test("unknown policy kinds are not silently treated as Sentinel", async () => {
  fixture("future-engine");
  const view = page();
  await view.findByText("Unsupported policy engine");
  expect(view.queryByRole("button", { name: "Add policy" })).toBeNull();
});

test("Sentinel still offers its policy editor", async () => {
  fixture("sentinel");
  const view = page();
  expect(await view.findByRole("button", { name: "Add policy" })).toBeTruthy();
});

test("tag mode reflects backend semantics and persists all and disabled values", async () => {
  const patches = fixture("sentinel");
  const view = page("tags");
  const select = await view.findByLabelText("Tag matching mode");
  expect(view.getByText("key-only")).toBeTruthy();
  expect(view.getByText("Leave empty to match only a key-only tag, not arbitrary values.")).toBeTruthy();
  expect(
    view.getByText("Any include selector can include a workspace; any exclude selector can exclude it."),
  ).toBeTruthy();
  fireEvent.change(select, { target: { value: "all" } });
  await view.findByText(
    "All include selectors must match to include a workspace; all exclude selectors must match to exclude it.",
  );
  expect(patches[0]).toContain('"tag-selector-matching-logic":"all"');
  fireEvent.change(view.getByLabelText("Tag matching mode"), { target: { value: "disabled" } });
  await view.findByText("Tag selectors are ignored. Global scope and direct attachments still apply.");
  expect(patches[1]).toContain('"tag-selector-matching-logic":null');
});

test("read-only users cannot change tag matching mode", async () => {
  const patches = fixture("sentinel", null, false);
  const view = page("tags");
  await waitFor(() => {
    const select = view.getByLabelText("Tag matching mode") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("disabled");
  });
  expect(patches).toHaveLength(0);
});

test("failed tag mode updates preserve the saved mode and display an error", async () => {
  fixture("sentinel", "any", true, true);
  const view = page("tags");
  fireEvent.change(await view.findByLabelText("Tag matching mode"), { target: { value: "all" } });
  await view.findByText(/Update rejected/);
  expect((view.getByLabelText("Tag matching mode") as HTMLSelectElement).value).toBe("any");
});

test("key-only duplicate selectors are rejected before submission", async () => {
  fixture("sentinel");
  const view = page("tags");
  fireEvent.input(await view.findByLabelText(/Tag key/), { target: { value: "production" } });
  fireEvent.click(view.getByRole("button", { name: "Add selector" }));
  expect(await view.findByText("That tag selector already exists.")).toBeTruthy();
});

test("tag selector creation preserves case-sensitive keys and values", async () => {
  const requests = fixture("sentinel");
  const view = page("tags");
  fireEvent.input(await view.findByLabelText(/Tag key/), { target: { value: "Production" } });
  fireEvent.input(view.getByLabelText("Tag value"), { target: { value: "US-East" } });
  fireEvent.click(view.getByRole("button", { name: "Add selector" }));
  await waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  expect(JSON.parse(requests[0] ?? "{}")).toEqual({
    data: [{ "tag-key": "Production", "tag-value": "US-East", "is-exclude": false }],
  });
});
