import { afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AdminAppearance } from "../src/views/AdminAppearance";
import {
  SafeAnnouncementBody,
  SiteBanner,
  SiteHelp,
  SitePresentationProvider,
  safeWebLink,
} from "../src/components/SitePresentation";
import { AUTH_EXPIRED_EVENT } from "../src/lib/api";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/vnd.api+json" } });
const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

test("safe announcement HTML retains emphasis and safe links without executable content", () => {
  const view = render(
    <SafeAnnouncementBody
      html={
        '<strong>Important</strong><em>Now</em><a href="https://example.com" onclick="alert(1)">Safe</a><a href="javascript:alert(1)">Unsafe</a><script>bad()</script><img src="https://track.test">'
      }
    />,
  );
  expect(view.getByText("Important").tagName).toBe("STRONG");
  expect(view.getByText("Now").tagName).toBe("EM");
  expect(view.getByRole("link").getAttribute("onclick")).toBeNull();
  expect(view.container.querySelectorAll("a").length).toBe(1);
  expect(view.container.querySelector("script,img")).toBeNull();
  expect(safeWebLink("javascript:alert(1)")).toBeUndefined();
});

test("admin saves all customization fields, creates scheduled banners and updates existing banners", async () => {
  let banner: unknown = null;
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    if (init?.method === "PATCH" || init?.method === "POST") {
      const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as {
        data: { attributes: Record<string, unknown> };
      };
      calls.push({ url, method: init.method, body: body.data.attributes });
      if (url.includes("banners")) {
        banner = { id: "ban-1", attributes: body.data.attributes };
        return json({ data: banner });
      }
      return json({ data: { attributes: body.data.attributes } });
    }
    if (url.endsWith("banners")) return json({ data: [] });
    return json({
      data: { attributes: { footer: "Old footer", "avatar-sources": [{ source: "gravatar", enabled: true }] } },
    });
  }) as unknown as typeof fetch;
  const view = render(<AdminAppearance />);
  await waitFor(() => {
    expect(view.getByLabelText("Footer")).toBeTruthy();
  });
  fireEvent.input(view.getByLabelText("Footer"), { target: { value: "New footer" } });
  fireEvent.click(view.getByLabelText("Enable Gravatar user avatars"));
  fireEvent.click(view.getByRole("button", { name: "Save customization" }));
  await waitFor(() => {
    expect(view.getByText("Customization saved.")).toBeTruthy();
  });
  expect(calls[0]?.body["footer"]).toBe("New footer");
  expect(calls[0]?.body["avatar-sources"]).toEqual([{ source: "gravatar", enabled: false }]);
  fireEvent.input(view.getByLabelText("Title"), { target: { value: "Maintenance" } });
  fireEvent.input(view.getByLabelText("Body"), { target: { value: "Scheduled downtime" } });
  fireEvent.click(view.getByLabelText("Schedule publication and expiry"));
  fireEvent.input(view.getByLabelText("Publish at (UTC)"), { target: { value: "2030-01-01T09:00" } });
  fireEvent.input(view.getByLabelText("Expire at (UTC)"), { target: { value: "2030-01-01T10:00" } });
  fireEvent.click(view.getByRole("button", { name: "Save announcement" }));
  await waitFor(() => {
    expect(calls.length).toBe(2);
  });
  expect(calls[1]?.method).toBe("POST");
  expect(calls[1]?.body["scheduled-publish-at"]).toBe("2030-01-01T09:00:00.000Z");
  await waitFor(() => {
    expect(view.getByRole("button", { name: "Deactivate" })).toBeTruthy();
  });
  fireEvent.input(view.getByLabelText("Title"), { target: { value: "Updated maintenance" } });
  fireEvent.click(view.getByRole("button", { name: "Save announcement" }));
  await waitFor(() => {
    expect(calls.length).toBe(3);
  });
  expect(calls[2]?.url).toBe("/api/v2/admin/banners/ban-1");
  expect(calls[2]?.method).toBe("PATCH");
});

test("presentation clears private settings immediately on session expiry and refreshes", async () => {
  let signedIn = true;
  globalThis.fetch = (async () =>
    json({
      data: {
        attributes: signedIn
          ? { "internal-support-url": "https://internal.test", "login-help": "Welcome" }
          : { "login-help": "Sign in" },
      },
    })) as unknown as typeof fetch;
  const view = render(
    <SitePresentationProvider>
      <SiteHelp mode="signin" />
      <SiteBanner />
    </SitePresentationProvider>,
  );
  await waitFor(() => {
    expect(view.getByRole("link", { name: "Internal support" })).toBeTruthy();
  });
  signedIn = false;
  act(() => {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  });
  await waitFor(() => {
    expect(view.queryByRole("link", { name: "Internal support" })).toBeNull();
    expect(view.getByText("Sign in")).toBeTruthy();
  });
});

test("failed loading exposes retry without editable controls", async () => {
  let failed = true;
  globalThis.fetch = (async (input: string | URL | Request) =>
    failed
      ? new Response(JSON.stringify({ errors: [{ title: "Not Found" }] }), { status: 404 })
      : json(
          urlOf(input).endsWith("banners") ? { data: [] } : { data: { attributes: {} } },
        )) as unknown as typeof fetch;
  const view = render(<AdminAppearance />);
  await waitFor(() => {
    expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
  expect(view.queryByRole("button", { name: "Save customization" })).toBeNull();
  failed = false;
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  await waitFor(() => {
    expect(view.getByRole("button", { name: "Save customization" })).toBeTruthy();
  });
});

test("failed banner saves keep edits; deactivation requires confirmation", async () => {
  let deleted = false;
  const banner = {
    id: "ban-existing",
    attributes: {
      title: "Existing",
      body: "Notice",
      style: "info",
      audience: "all_users",
      "scheduled-publish-at": null,
      "scheduled-expire-at": null,
      timezone: null,
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      deleted = true;
      return new Response(null, { status: 204 });
    }
    if (init?.method === "PATCH")
      return new Response(JSON.stringify({ errors: [{ title: "Validation failed", detail: "Invalid schedule" }] }), {
        status: 422,
      });
    return json(urlOf(input).endsWith("banners") ? { data: [banner] } : { data: { attributes: {} } });
  }) as unknown as typeof fetch;
  const view = render(<AdminAppearance />);
  await waitFor(() => {
    expect(view.getByDisplayValue("Existing")).toBeTruthy();
  });
  fireEvent.input(view.getByLabelText("Title"), { target: { value: "Edited" } });
  fireEvent.click(view.getByRole("button", { name: "Save announcement" }));
  await waitFor(() => {
    expect(view.getByRole("alert").textContent).toContain("Invalid schedule");
  });
  expect(view.getByDisplayValue("Edited")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Deactivate" }));
  expect(deleted).toBe(false);
  const dialog = view.getByRole("dialog");
  const confirm = Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Deactivate");
  expect(confirm).toBeDefined();
  if (confirm === undefined) throw new Error("Missing confirmation button");
  fireEvent.click(confirm);
  await waitFor(() => {
    expect(deleted).toBe(true);
    expect(view.getByText("Announcement deactivated.")).toBeTruthy();
  });
});

test("expired announcements are not rendered and public help remains plain text", async () => {
  globalThis.fetch = (async () =>
    json({
      data: {
        attributes: {
          "login-help": "<script>not HTML</script>",
          banner: {
            id: "expired",
            attributes: {
              title: "Expired announcement",
              body: "Old",
              style: "info",
              "scheduled-expire-at": "2000-01-01T00:00:00Z",
            },
          },
        },
      },
    })) as unknown as typeof fetch;
  const view = render(
    <SitePresentationProvider>
      <SiteBanner />
      <SiteHelp mode="signin" />
    </SitePresentationProvider>,
  );
  await waitFor(() => {
    expect(view.getByText("<script>not HTML</script>")).toBeTruthy();
  });
  expect(view.queryByText("Expired announcement")).toBeNull();
  expect(view.container.querySelector("script")).toBeNull();
});
