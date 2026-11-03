import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { SamlCertificates } from "../src/views/admin/saml-certificates";

const originalFetch = globalThis.fetch;
const certificate = (id: string, role = "managed") => ({
  id,
  type: "saml-idp-certificates",
  attributes: {
    "display-name": id,
    "cert-role": role,
    fingerprint: "AA:BB",
    "expires-at": "2028-01-01T00:00:00.000Z",
    issuer: "CN=Example",
  },
});
afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("lists trust metadata, keeps legacy settings separate, and renames without rotating", async () => {
  let body = "";
  globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    if (init?.method === "PATCH") body = typeof init.body === "string" ? init.body : "";
    return Response.json({ data: [certificate("managed"), certificate("legacy", "legacy_primary")] });
  }) as typeof fetch;
  const view = render(<SamlCertificates refreshKey={false} />);
  await waitFor((): void => {
    expect(view.getByRole("button", { name: "Edit managed" })).toBeTruthy();
  });
  expect(view.getAllByText("AA:BB").length).toBe(2);
  expect(view.getByRole("button", { name: "Revoke and delete legacy" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Edit managed" }));
  fireEvent.input(view.getByLabelText("Certificate display name"), { target: { value: "New name" } });
  fireEvent.click(view.getByRole("button", { name: "Save certificate" }));
  await waitFor((): void => {
    expect(body).toContain('"display-name":"New name"');
  });
  expect(body).not.toContain('"cert":');
});

test("adding requires explicit trust confirmation and preserves errors", async () => {
  let writes = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    if (init?.method === "POST") {
      writes += 1;
      return Response.json({ errors: [{ detail: "Certificate is already trusted" }] }, { status: 422 });
    }
    return Response.json({ data: [] });
  }) as typeof fetch;
  const view = render(<SamlCertificates refreshKey={false} />);
  await waitFor((): void => {
    expect(view.getByText("No trusted certificates configured.")).toBeTruthy();
  });
  fireEvent.input(view.getByLabelText("Certificate display name"), { target: { value: "IdP" } });
  fireEvent.input(view.getByLabelText("Certificate PEM"), { target: { value: "PEM" } });
  fireEvent.click(view.getByRole("button", { name: "Add certificate" }));
  expect(writes).toBe(0);
  fireEvent.click(await view.findByRole("button", { name: "Trust certificate" }));
  await waitFor((): void => {
    expect(view.getByRole("alert").textContent).toContain("Certificate is already trusted");
  });
  expect(writes).toBe(1);
});

test("delete requires confirmation and surfaces server lockout protection", async () => {
  let deletes = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    if (init?.method === "DELETE") {
      deletes += 1;
      return Response.json(
        { errors: [{ detail: "Cannot remove the last trusted certificate while SAML is enabled" }] },
        { status: 422 },
      );
    }
    return Response.json({ data: [certificate("current")] });
  }) as typeof fetch;
  const view = render(<SamlCertificates refreshKey={false} />);
  fireEvent.click(await view.findByRole("button", { name: "Revoke and delete current" }));
  expect(deletes).toBe(0);
  fireEvent.click(await view.findByRole("button", { name: "Revoke and delete" }));
  await waitFor((): void => {
    expect(view.getByRole("alert").textContent).toContain("last trusted certificate");
  });
  expect(deletes).toBe(1);
});

test("revoking legacy primary synchronizes the settings editor only after success", async () => {
  let removed = false;
  let synchronized = false;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    if (init?.method === "DELETE") {
      removed = true;
      return new Response(null, { status: 204 });
    }
    return Response.json({ data: removed ? [] : [certificate("legacy", "legacy_primary")] });
  }) as typeof fetch;
  const view = render(
    <SamlCertificates
      refreshKey={false}
      onLegacyPrimaryRemoved={(): void => {
        synchronized = true;
      }}
    />,
  );
  fireEvent.click(await view.findByRole("button", { name: "Revoke and delete legacy" }));
  expect(synchronized).toBe(false);
  fireEvent.click(await view.findByRole("button", { name: "Revoke and delete" }));
  await waitFor((): void => {
    expect(synchronized).toBe(true);
  });
  expect(await view.findByText("No trusted certificates configured.")).toBeTruthy();
});

test("replacement is explicit and cancellation sends no request", async () => {
  let writes = 0;
  let body = "";
  globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    if (init?.method === "PATCH") {
      writes += 1;
      body = typeof init.body === "string" ? init.body : "";
    }
    return Response.json({ data: [certificate("current")] });
  }) as typeof fetch;
  const view = render(<SamlCertificates refreshKey={false} />);
  fireEvent.click(await view.findByRole("button", { name: "Edit current" }));
  fireEvent.input(view.getByLabelText("Replacement certificate PEM (leave blank to keep)"), {
    target: { value: "NEW PEM" },
  });
  fireEvent.click(view.getByRole("button", { name: "Save certificate" }));
  fireEvent.click(await view.findByRole("button", { name: "Cancel" }));
  expect(writes).toBe(0);
  fireEvent.click(view.getByRole("button", { name: "Save certificate" }));
  fireEvent.click(await view.findByRole("button", { name: "Trust certificate" }));
  await waitFor((): void => {
    expect(writes).toBe(1);
  });
  expect(body).toContain('"cert":"NEW PEM"');
});
