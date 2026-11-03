import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { StackSettings } from "../src/views/StackSettings";
import type { JsonObject } from "../src/lib/json";
const originalFetch = globalThis.fetch;
afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
  localStorage.clear();
});

test.each(["preserve", "replace", "unavailable", "github", "unknown", "clear"] as const)(
  "Stack connection picker %s keeps credentials scoped and saves the selected source",
  async (scenario) => {
    let payload: JsonObject | undefined;
    const stack = {
      id: "stack-azure",
      attributes: {
        name: "Azure stack",
        "vcs-repo": {
          identifier: "stack-submodules/project/_git/repo",
          "service-provider": scenario === "unknown" ? null : "ado_services",
          "oauth-token-id": "ot-saved",
          "ingress-submodules": true,
        },
      },
    };
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/v2/organizations/stack-submodules")
        return Response.json({ data: { attributes: { permissions: { "can-manage-projects": true } } } });
      if (url.endsWith("/github-app/installations"))
        return Response.json({ data: [{ id: "gha-saved", attributes: { name: "Team GitHub" } }] });
      if (url.endsWith("/oauth-clients"))
        return scenario === "unavailable" || scenario === "unknown"
          ? Response.json({ errors: [{ detail: "Connections unavailable" }] }, { status: 503 })
          : Response.json({
              data: [
                {
                  id: "azure-connection",
                  attributes: {
                    name: "Team Azure",
                    "service-provider": "ado_services",
                    "service-provider-display-name": "Azure DevOps Services",
                  },
                },
                {
                  id: "server-connection",
                  attributes: { name: "Unsupported Server", "service-provider": "ado_server" },
                },
              ],
            });
      if (url.endsWith("/oauth-clients/azure-connection/oauth-tokens"))
        return Response.json({
          data: [
            { id: "ot-saved", attributes: {} },
            { id: "ot-replacement", attributes: { "service-provider-user": "replacement" } },
          ],
        });
      if (url.endsWith("/organizations/stack-submodules/stacks")) return Response.json({ data: [stack] });
      if (url.endsWith("/projects"))
        return Response.json({ data: [{ id: "prj-one", attributes: { name: "Default" } }] });
      if (url.includes("/agent-pools") || url.includes("/stack-configurations")) return Response.json({ data: [] });
      if (url === "/api/v2/stacks/stack-azure" && init?.method === "PATCH") {
        payload = JSON.parse(init.body as string) as JsonObject;
        return Response.json({ data: stack });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const view = render(
      <MemoryRouter initialEntries={["/app/stack-submodules/settings/stacks"]}>
        <Routes>
          <Route path="/app/:orgName/settings/stacks" element={<StackSettings />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await view.findByRole("button", { name: "Edit Azure stack" }));
    const checkbox = view.queryByLabelText("Include Azure DevOps Git submodules");
    if (scenario === "unknown") expect(checkbox).toBeNull();
    else expect(checkbox?.getAttribute("aria-checked")).toBe("true");
    const picker = view.getByLabelText("VCS connection") as HTMLSelectElement;
    await waitFor((): void => {
      expect(picker.disabled).toBe(false);
    });
    expect(picker.value).toBe("oauth-token:ot-saved");
    expect(view.queryByLabelText("VCS connection token ID")).toBeNull();
    if (scenario === "unavailable" || scenario === "unknown")
      expect(view.getByRole("alert").textContent).toContain("saved connection has not been changed");
    else {
      expect([...picker.options].some((option): boolean => option.textContent.includes("Team Azure"))).toBe(true);
      expect([...picker.options].some((option): boolean => option.textContent.includes("Unsupported Server"))).toBe(
        false,
      );
    }
    if (scenario === "replace") fireEvent.change(picker, { target: { value: "oauth-token:ot-replacement" } });
    if (checkbox !== null && scenario !== "clear") fireEvent.click(checkbox);
    if (scenario === "clear") {
      fireEvent.change(picker, { target: { value: "" } });
      expect(picker.value).toBe("");
      expect(checkbox?.getAttribute("aria-checked")).toBe("false");
    }
    if (scenario === "github") {
      fireEvent.change(picker, { target: { value: "github-app:gha-saved" } });
      expect(view.queryByLabelText("Include Azure DevOps Git submodules")).toBeNull();
    }
    fireEvent.click(view.getByRole("button", { name: "Save changes" }));
    await waitFor((): void => {
      expect(payload).toBeDefined();
    });
    expect(payload).toMatchObject({
      data: {
        attributes: {
          "vcs-repo":
            scenario === "github"
              ? { "github-app-installation-id": "gha-saved", "service-provider": "github" }
              : {
                  ...(scenario === "clear"
                    ? {}
                    : { "oauth-token-id": scenario === "replace" ? "ot-replacement" : "ot-saved" }),
                  "ingress-submodules": scenario === "unknown",
                },
        },
      },
    });
    if (scenario === "github" || scenario === "clear") expect(JSON.stringify(payload)).not.toContain("oauth-token-id");
    if (scenario === "clear") expect(JSON.stringify(payload)).not.toContain("github-app-installation-id");
    if (scenario === "unknown") expect(JSON.stringify(payload)).not.toContain("service-provider");
  },
);
