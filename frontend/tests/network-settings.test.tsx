import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { OrganizationCidrRanges } from "../src/components/OrganizationCidrRanges";
import { WorkspaceConfigurationVersions } from "../src/components/WorkspaceConfigurationVersions";
import { isString } from "../src/lib/type-guards";

const originalFetch = globalThis.fetch;
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const urlOf = (input: string | URL | Request): string => isString(input) ? input : input instanceof URL ? input.toString() : input.url;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

test("manages CIDR lists and ranges through the JSON API", async () => {
  let ranges = [{ id: "range-1", attributes: { value: "10.0.0.0/8" } }];
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme/cidr-range-lists") return json({ data: [{ id: "list-1", attributes: { name: "Private" } }] });
    if (url.startsWith("/api/v2/cidr-ranges?")) return json({ data: ranges });
    if (url === "/api/v2/cidr-ranges" && init?.method === "POST") { ranges = [...ranges, { id: "range-2", attributes: { value: "192.168.0.0/16" } }]; return json({ data: ranges[1] }, 201); }
    if (url === "/api/v2/cidr-ranges/range-1" && init?.method === "DELETE") { ranges = []; return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;
  const view = render(<OrganizationCidrRanges orgName="acme" />);
  await waitFor(() => { expect(view.getByText("10.0.0.0/8")).toBeTruthy(); });
  fireEvent.input(view.getByLabelText("CIDR range"), { target: { value: "192.168.0.0/16" } });
  fireEvent.click(view.getByRole("button", { name: "Add range" }));
  await waitFor(() => { expect(view.getByText("192.168.0.0/16")).toBeTruthy(); });
  expect(fetchMock.mock.calls.some(([input]) => urlOf(input) === "/api/v2/cidr-ranges")).toBe(true);
});

test("lists and creates workspace configuration versions", async () => {
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/workspaces/ws-1/configuration-versions" && init?.method === "POST") return json({ data: { id: "cv-2", attributes: { status: "pending", source: "tfe-api" } } }, 201);
    if (url.startsWith("/api/v2/workspaces/ws-1/configuration-versions")) return json({ data: [{ id: "cv-1", attributes: { status: "uploaded", source: "vcs" } }] });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;
  const view = render(<WorkspaceConfigurationVersions workspaceId="ws-1" />);
  await waitFor(() => { expect(view.getByText("cv-1")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "New version" }));
  await waitFor(() => { expect(view.getByText("cv-2")).toBeTruthy(); });
});