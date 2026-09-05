import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { UsersAdmin } from "../src/views/admin/users";

const originalFetch = globalThis.fetch;
const users = [
  { id: "user-alex", attributes: { username: "alex", email: "alex@example.test", "can-reset-password": true } },
  { id: "user-sam", attributes: { username: "sam", email: "sam@example.test", "can-reset-password": false } },
];
const renderUsers = () => render(<UsersAdmin users={users} setCreateDialogOpen={() => {}} setDeleteUserId={() => {}} loadAdminData={async () => {}} />);
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

test("filters by email and edits identity through the existing user endpoint", async () => {
  const fetchMock = mock(async () => new Response(JSON.stringify({ data: {} }), { headers: { "Content-Type": "application/json" } }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const view = renderUsers();
  fireEvent.input(view.getByRole("searchbox", { name: "Search users" }), { target: { value: "alex@" } });
  expect(view.queryByText("sam")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Edit" }));
  const dialog = within(view.getByRole("dialog"));
  fireEvent.input(dialog.getByLabelText("Username"), { target: { value: "alex-lab" } });
  fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/v2/admin/users/user-alex");
  expect(init.method).toBe("PATCH");
  expect(JSON.parse(init.body as string).data.attributes).toEqual({ username: "alex-lab", email: "alex@example.test" });
});

test("password recovery explains session revocation, validates confirmation, and leaves failed requests open", async () => {
  const fetchMock = mock(async () => new Response(JSON.stringify({ errors: [{ detail: "Password must be at least 12 characters." }] }), { status: 422, headers: { "Content-Type": "application/json" } }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const view = renderUsers();
  const samRow = within(view.getByText("sam").closest("tr")!);
  expect(samRow.getByRole("button", { name: "Reset password" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(within(view.getByText("alex").closest("tr")!).getByRole("button", { name: "Reset password" }));
  const dialog = within(view.getByRole("dialog"));
  expect(dialog.getByText(/revokes their API tokens/)).toBeTruthy();
  fireEvent.input(dialog.getByLabelText("Temporary password"), { target: { value: "short" } });
  fireEvent.input(dialog.getByLabelText("Confirm temporary password"), { target: { value: "different" } });
  fireEvent.submit(dialog.getByRole("button", { name: "Reset password" }).closest("form")!);
  expect(dialog.getByRole("alert").textContent).toBe("Passwords do not match.");
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.input(dialog.getByLabelText("Confirm temporary password"), { target: { value: "short" } });
  fireEvent.submit(dialog.getByRole("button", { name: "Reset password" }).closest("form")!);
  await waitFor(() => expect(dialog.getByRole("alert").textContent).toContain("Password must be at least 12"));
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/v2/admin/users/user-alex/actions/reset_password");
  expect(JSON.parse(init.body as string).data.attributes).toEqual({ password: "short", "password-confirmation": "short" });
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(view.getByText("alex").closest("tr")!).getByRole("button", { name: "Reset password" }));
  expect((view.getByLabelText("Temporary password") as HTMLInputElement).value).toBe("");
});

test("role changes require confirmation before sending a request", async () => {
  const fetchMock = mock(async () => new Response(JSON.stringify({ data: {} }), { headers: { "Content-Type": "application/json" } }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const view = renderUsers();
  fireEvent.click(view.getByRole("button", { name: "More actions for alex" }));
  fireEvent.click(await view.findByRole("menuitem", { name: "Promote" }));
  expect(fetchMock).not.toHaveBeenCalled();
  const dialog = within(view.getByRole("dialog"));
  expect(dialog.getByText(/manage every organization/)).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Confirm change" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
});
