import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { RunDetail } from "../src/views/RunDetail";
import { RunList } from "../src/views/RunList";
import { WorkspaceDetail } from "../src/views/WorkspaceDetail";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";
import { anyPhaseLog, handlePhaseLogs, phaseLogResponse } from "./support/run-log-fixture";

const originalFetch = globalThis.fetch;
const originalClipboard = navigator.clipboard;

function json(data: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (isString(input)) return input;
  return input instanceof URL ? input.toString() : input.url;
}

function CurrentLocation(): React.JSX.Element {
  const location = useLocation();
  return <output aria-label="Current location">{location.pathname}{location.search}</output>;
}

/** Type into a controlled field the way React observes here (see
 * admin-bootstrap.test.tsx): reset the value tracker, set the value, then
 * fire input+change. Bare fireEvent.change updates the DOM but never
 * reaches React state in this renderer. */
function changeInput(element: HTMLElement, value: string): void {
  const tracker = (element as { _valueTracker?: { setValue: (next: string) => void } })._valueTracker;
  tracker?.setValue(value === "" ? "x" : "");
  Reflect.set(element, "value", value);
  fireEvent.input(element, { target: { value } });
  fireEvent.change(element, { target: { value } });
}

/** Terminal fetch step shared by every mock below (CodeRabbit review): serve
 * the empty phase-log fallback for log reads, otherwise fail loudly so a
 * missing stub surfaces as an error instead of a hanging waitFor. */
function phaseLogOrThrow(url: string): Response {
  const fallback = anyPhaseLog(url);
  if (fallback !== null) return fallback;
  throw new Error(`Unexpected request: ${url}`);
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
  Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
});

test("separates phase logs and only renders backend-authorized run actions", async () => {
  let applied = false;
  let applyBody: unknown;
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          attributes: {
            name: "production",
            description: "Production infrastructure",
            permissions: {
              "can-queue-run": true,
            },
          },
        },
      });
    }
    if (url === "/api/v2/runs/run-polished/actions/apply" && init?.method === "POST") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      applyBody = isString(init.body) ? JSON.parse(init.body) as unknown : undefined;
      applied = true;
      return new Response(null, { status: 202 });
    }
    if (url === "/api/v2/runs/run-polished") {
      return json({
        data: {
          id: "run-polished",
          attributes: {
            message: "Polished lifecycle",
            status: applied ? "applied" : "planned",
            actions: {
              "is-confirmable": !applied,
              "is-discardable": false,
              "is-cancelable": false,
              "is-force-cancelable": false,
            },
            permissions: {
              "can-apply": true,
              "can-discard": true,
              "can-cancel": true,
              "can-force-cancel": true,
              "can-comment": true,
            },
            "created-at": "2026-07-29T10:00:00.000Z",
            "status-timestamps": {
              "planning-at": "2026-07-29T09:00:01.000Z",
              "planned-at": "2026-07-29T09:00:02.000Z",
              ...(applied
                ? {
                    "applying-at": "2026-07-29T09:00:03.000Z",
                    "applied-at": "2026-07-29T09:00:04.000Z",
                  }
                : undefined),
            },
          },
        },
      });
    }
    {
      const phaseLog = handlePhaseLogs(url, "run-polished", {
        plan: "PLAN_PHASE_ONLY\nPLAN_PHASE_SECOND",
        apply: "APPLY_PHASE_ONLY\nAPPLY_PHASE_SECOND",
      });
      if (phaseLog !== null) return phaseLog;
    }
    if (url === "/api/v2/runs/run-polished/plan") {
      return json({
        data: {
          attributes: {
            status: "finished",
            "log-read-url": "http://terrence.test/api/v2/runs/run-polished/plan/log/token",
            "resource-additions": 1,
            "resource-changes": 2,
            "resource-destructions": 3,
            "resource-imports": 2,
            "status-timestamps": {
              "planning-at": "2026-07-29T09:00:01.000Z",
              "planned-at": "2026-07-29T09:00:02.000Z",
            },
          },
        },
      });
    }
    if (url === "/api/v2/applies/apply-run-polished") {
      return json({
        data: {
          attributes: {
            status: applied ? "finished" : "pending",
            "resource-additions": applied ? 1 : 0,
            "resource-changes": applied ? 2 : 0,
            "resource-destructions": applied ? 3 : 0,
            "resource-imports": applied ? 4 : 0,
          },
        },
      });
    }
    if (url === "/api/v2/plans/plan-run-polished/json-output") {
      return json({
        terraform_version: "1.11.0",
        action_invocations: [
          { address: "terraform_data.first" },
          { address: "terraform_data.second" },
        ],
        resource_changes: [{
          address: "aws_vpc.main",
          type: "aws_vpc",
          change: {
            actions: ["create"],
            before: null,
            after: { cidr_block: "10.0.0.0/16" },
          },
        }, {
          address: "aws_instance.web",
          type: "aws_instance",
          change: {
            actions: ["create"],
            before: null,
            after: { instance_type: "t3.small" },
            importing: { id: "i-web" },
          },
        }],
        configuration: {
          root_module: {
            resources: [{ address: "aws_vpc.main", expressions: {} }, {
              address: "aws_instance.web",
              expressions: { vpc_id: { references: ["aws_vpc.main.id"] } },
            }],
          },
        },
      });
    }
    if (url.endsWith("/cost-estimate")) return json({ data: null });
    if (url === "/api/v2/runs/run-polished/run-events") {
      return json({
        data: [{
          id: "event-confirmed",
          type: "run-events",
          attributes: {
            action: "apply",
            "actor-username": "essinghigh",
            "created-at": "2026-07-29T09:00:03.000Z",
            details: { fromStatus: "planned", toStatus: "confirmed" },
          },
        }],
      });
    }
    if (url === "/api/v2/runs/run-polished/comments") {
      return json({
        data: [{
          id: "comment-1",
          type: "comments",
          attributes: {
            body: "Approved for production",
            "actor-username": "essinghigh",
            "created-at": "2026-07-29T09:00:02.500Z",
          },
        }],
      });
    }
    if (url.endsWith("/policy-checks")) return json({ data: [] });
    return phaseLogOrThrow(url);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;
  const writeText = mock(async (text: string): Promise<void> => {
    expect(text).toBe("run-polished");
  });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs/run-polished"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<WorkspaceDetail section="run-detail" />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("aws_instance.web", { selector: "code" })).toBeTruthy();
  });

  // Query by the id the <details> points its aria-labelledby at: the decision
  // panel's own heading can also begin with "Apply".
  const planSection = view.container.querySelector("#plan-heading")?.closest("details") ?? null;
  const applySection = view.container.querySelector("#apply-heading")?.closest("details") ?? null;
  expect(planSection).not.toBeNull();
  expect(applySection).not.toBeNull();
  // SAFETY: closest("details") above resolved the details elements for the headings.
  expect((planSection as HTMLDetailsElement).open).toBeTrue();
  // SAFETY: closest("details") above resolved the details elements for the headings.
  expect((applySection as HTMLDetailsElement).open).toBeFalse();
  // SAFETY: closest("details") above resolved the details elements for the headings.
  const planLog = (planSection as HTMLDetailsElement).querySelector("pre");
  // SAFETY: closest("details") above resolved the details elements for the headings.
  const applyLog = (applySection as HTMLDetailsElement).querySelector("pre");
  expect(planLog?.textContent).toBe("PLAN_PHASE_ONLY\nPLAN_PHASE_SECOND");
  expect(applyLog?.textContent).toBe("APPLY_PHASE_ONLY\nAPPLY_PHASE_SECOND");
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
  expect(within(planSection as HTMLElement).queryByText("APPLY_PHASE_ONLY")).toBeNull();
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
  expect(within(planSection as HTMLElement).getByRole("link", { name: "Download raw log" })).toBeTruthy();
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
  expect(within(planSection as HTMLElement).getByText(/Started/)).toBeTruthy();
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
  // "Finished" renders twice by design: the heading status label and the
  // completed timestamp in the phase meta row.
  expect(within(planSection as HTMLElement).getAllByText(/Finished/)).toHaveLength(2);
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
  expect(within(applySection as HTMLElement).queryByText("PLAN_PHASE_ONLY")).toBeNull();
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
  expect(within(applySection as HTMLElement).getByText("Resources pending")).toBeTruthy();
  expect(view.getByText("Plan & apply duration")).toBeTruthy();
  expect(view.getByText("Less than a minute")).toBeTruthy();
  expect(view.getByText("Resources changed", { selector: "dt" })).toBeTruthy();
  // One decision surface, stating what the run wants rather than four
  // separately-derived claims about it.
  expect(view.getByRole("heading", { name: "This run is waiting for you to apply it" }))
    .toBeTruthy();
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
  expect(within(planSection as HTMLElement).queryByText("&2 to import")).toBeNull();
  expect(view.getByText("Resources changed", { selector: "dt" }).closest("div")?.textContent).toContain("&2 to import");
  await waitFor((): void => {
    expect(view.getByText("Actions", { selector: "dt" }).closest("div")?.textContent).toContain("2 to invoke");
  });

  expect(view.getByRole("button", { name: "Apply changes" })).toBeTruthy();
  expect(view.getByRole("link", { name: "New run" }).getAttribute("href"))
    .toBe("/app/acme/workspaces/production/runs?new-run=true");
  expect(view.getAllByRole("navigation", { name: "Breadcrumb" })).toHaveLength(1);
  expect(view.getByLabelText("Copy run ID")).toBeTruthy();
  expect(view.getByText("Run ID:")).toBeTruthy();
  fireEvent.click(view.getByLabelText("Copy run ID"));
  await waitFor((): void => { expect(writeText).toHaveBeenCalledWith("run-polished"); });
  expect(view.queryByRole("button", { name: "Discard run" })).toBeNull();
  expect(view.queryByRole("button", { name: "Cancel run" })).toBeNull();
  expect(view.queryByRole("button", { name: "Force cancel" })).toBeNull();

  const activitySection = view.getByRole("heading", { name: "Activity" }).closest("section");
  const commentsSection = view.getByRole("heading", { name: "Comments" }).closest("section");
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
  expect(within(activitySection as HTMLElement).getByText("Run confirmed")).toBeTruthy();
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
  expect(within(activitySection as HTMLElement).getByText("Needs confirmation → Confirmed")).toBeTruthy();
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
  expect(within(activitySection as HTMLElement).getByText("essinghigh")).toBeTruthy();
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
  expect(within(commentsSection as HTMLElement).getByText("essinghigh")).toBeTruthy();
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
  expect(within(commentsSection as HTMLElement).getByText("Approved for production")).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: "Apply changes" }));
  expect(view.getByRole("heading", { name: "Apply these changes?" })).toBeTruthy();
// SAFETY: the component renders this element type for the queried role/label.
// Scoped to the confirmation step: the comments section form below carries a
// matching label since the UI rework.
  const confirmSection = view.getByRole("heading", { name: "Apply these changes?" }).closest("section");
  const actionComment = within(confirmSection as HTMLElement).getByLabelText(/^Comment/) as HTMLTextAreaElement;
  changeInput(actionComment, "Approved after reviewing the dependency graph");
  expect(actionComment.value).toBe("Approved after reviewing the dependency graph");
  // The committal button does not share its name with the offer that opened
  // it, so the two steps are distinguishable by label alone.
  fireEvent.click(view.getByRole("button", { name: "Yes, apply changes" }));
  await waitFor((): void => {
    expect(view.container.querySelector("#apply-heading")?.textContent ?? "").toContain("Finished");
  });
  expect(applyBody).toMatchObject({
    data: { attributes: { comment: "Approved after reviewing the dependency graph" } },
  });
  expect(view.getByText("Actions", { selector: "dt" }).closest("div")?.textContent).toContain("2 invoked");
  expect(view.getByText("Resources changed", { selector: "dt" }).closest("div")?.textContent).toContain("&4 to import");
  expect(view.getByText("Less than a minute")).toBeTruthy();
});

test("opens a requested run dialog, sends the selected run type, and navigates to the run", async () => {
  let createBody: unknown;
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/workspaces/ws-1/runs" || url === "/api/v2/workspaces/ws-1/runs?sort=-created-at") return json({ data: [] });
    if (url === "/api/v2/runs" && init?.method === "POST") {
      if (!isString(init.body)) throw new Error("Expected a JSON request body");
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      createBody = JSON.parse(init.body) as unknown;
      return json({ data: { id: "run-plan-only" } }, 201);
    }
    return phaseLogOrThrow(url);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs?new-run=true"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs"
          element={<RunList workspaceId="ws-1" orgName="acme" workspaceName="production" />}
        />
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<p>Created run detail</p>}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("dialog")).toBeTruthy();
  });
  fireEvent.click(view.getByRole("radio", { name: "Plan only" }));
  fireEvent.click(view.getByRole("button", { name: "Start run" }));

  await waitFor((): void => {
    expect(view.getByText("Created run detail")).toBeTruthy();
  });
  expect(createBody).toMatchObject({
    data: {
      attributes: {
        "plan-only": true,
        "refresh-only": false,
        "allow-empty-apply": false,
        "auto-apply": false,
      },
    },
  });
});

test("clones an existing run's settings into the new-run dialog", async () => {
  let createBody: unknown;
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/workspaces/ws-1/runs" || url === "/api/v2/workspaces/ws-1/runs?sort=-created-at") {
      return json({
        data: [
          {
            id: "run-targeted",
            type: "runs",
            attributes: {
              message: "Targeted DB migration",
              status: "applied",
              "plan-only": true,
              "is-destroy": true,
              "target-addrs": ["aws_instance.db"],
              "replace-addrs": ["aws_instance.web", "aws_instance.api"],
            },
          },
        ],
      });
    }
    if (url === "/api/v2/runs" && init?.method === "POST") {
      if (!isString(init.body)) throw new Error("Expected a JSON request body");
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      createBody = JSON.parse(init.body) as unknown;
      return json({ data: { id: "run-cloned" } }, 201);
    }
    return phaseLogOrThrow(url);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs"
          element={<RunList workspaceId="ws-1" orgName="acme" workspaceName="production" canStartRun />}
        />
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<p>Cloned run detail</p>}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("button", { name: /Clone/ })).toBeTruthy();
  });
  fireEvent.click(view.getByRole("button", { name: /Clone/ }));

  await waitFor((): void => {
    expect(view.getByRole("dialog")).toBeTruthy();
  });
  // The cloned run's message, plan-only radio, destroy checkbox and address
  // fields are prefilled from the source run.
// SAFETY: the component renders this element type for the queried role/label.
  expect((view.getByLabelText("Run name") as HTMLInputElement).value).toBe("Targeted DB migration");
// SAFETY: the component renders this element type for the queried role/label.
  expect((view.getByRole("radio", { name: "Plan only" }) as HTMLInputElement).checked).toBe(true);
// SAFETY: the component renders this element type for the queried role/label.
  expect((view.getByRole("checkbox", { name: "Destroy infrastructure" }) as HTMLInputElement).checked).toBe(true);
// SAFETY: the component renders this element type for the queried role/label.
  expect((view.getByLabelText("Target addresses") as HTMLInputElement).value).toBe("aws_instance.db");
// SAFETY: the component renders this element type for the queried role/label.
  expect((view.getByLabelText("Replace addresses") as HTMLInputElement).value)
    .toBe("aws_instance.web, aws_instance.api");

  fireEvent.click(view.getByRole("button", { name: "Start run" }));
  await waitFor((): void => {
    expect(view.getByRole("heading", { name: "Destroy infrastructure?" })).toBeTruthy();
  });
  fireEvent.click(view.getByRole("button", { name: "Start destroy run" }));
  await waitFor((): void => {
    expect(view.getByText("Cloned run detail")).toBeTruthy();
  });
  expect(createBody).toMatchObject({
    data: {
      attributes: {
        message: "Targeted DB migration",
        "plan-only": true,
        "is-destroy": true,
        "target-addrs": ["aws_instance.db"],
        "replace-addrs": ["aws_instance.web", "aws_instance.api"],
      },
    },
  });
});

test("closing a deep-linked new-run dialog clears the query", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    if (requestUrl(input) === "/api/v2/workspaces/ws-1/runs" || requestUrl(input) === "/api/v2/workspaces/ws-1/runs?sort=-created-at") return json({ data: [] });
    return phaseLogOrThrow(requestUrl(input));
  })) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs?new-run=true"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs"
          element={(
            <>
              <RunList workspaceId="ws-1" canStartRun />
              <CurrentLocation />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("dialog")).toBeTruthy();
  });
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  await waitFor((): void => {
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.getByLabelText("Current location").textContent)
      .toBe("/app/acme/workspaces/production/runs");
  });
});

test("does not offer run creation without workspace permission", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    if (requestUrl(input) === "/api/v2/workspaces/ws-readonly/runs" || requestUrl(input) === "/api/v2/workspaces/ws-readonly/runs?sort=-created-at") return json({ data: [] });
    return phaseLogOrThrow(requestUrl(input));
  })) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter>
      <RunList
        workspaceId="ws-readonly"
        orgName="acme"
        workspaceName="production"
        canStartRun={false}
      />
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText(/do not have permission to start one/)).toBeTruthy();
  });
  expect(view.queryByRole("button", { name: "Start new run" })).toBeNull();
});

test("omits stages that cannot run for a finished plan-only run", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/runs/run-speculative") {
      return json({
        data: {
          id: "run-speculative",
          attributes: {
            message: "Speculative plan",
            status: "planned_and_finished",
            "plan-only": true,
            permissions: { "can-comment": true },
          },
        },
      });
    }
    if (url === "/api/v2/runs/run-speculative/plan") {
      return json({ data: { attributes: { status: "finished" } } });
    }
    if (url === "/api/v2/applies/apply-run-speculative") {
      return json({ data: { attributes: { status: "pending" } } });
    }
    if (url === "/api/v2/plans/plan-run-speculative/json-output") {
      return json({ resource_changes: [] });
    }
    if (url.endsWith("/logs")
      || url.endsWith("/policy-checks")
      || url.endsWith("/run-events")
      || url.endsWith("/comments")) {
      return json({ data: [] });
    }
    if (url.endsWith("/cost-estimate")) return json({ data: null });
    return phaseLogOrThrow(url);
  })) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs/run-speculative"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<RunDetail />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("Speculative plan")).toBeTruthy();
  });
  expect(view.queryByRole("heading", { name: /^Apply / })).toBeNull();
  expect(view.queryByRole("heading", { name: "Cost estimation" })).toBeNull();
  expect(view.queryByRole("heading", { name: "Policy check" })).toBeNull();
  expect(view.getByText("No run activity or comments yet.")).toBeTruthy();
  expect(view.getByText("Plan duration").nextElementSibling?.textContent).toBe("Unavailable");
});

test("opens failed applies and presents their diagnostics", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/runs/run-apply-error") {
      return json({
        data: {
          id: "run-apply-error",
          attributes: {
            message: "Apply with diagnostics",
            status: "errored",
            permissions: { "can-comment": false },
            "status-timestamps": {
              "planning-at": "2026-07-29T09:00:00.000Z",
              "planned-at": "2026-07-29T09:01:00.000Z",
              "applying-at": "2026-07-29T09:02:00.000Z",
              "errored-at": "2026-07-29T09:03:00.000Z",
            },
          },
        },
      });
    }
    if (url === "/api/v2/runs/run-apply-error/logs") {
      return json({
        data: [{
          attributes: {
            phase: "apply",
            "output-text": "Error: resource name already exists\n  on main.tf line 5",
          },
        }],
      });
    }
    if (url === "/api/v2/runs/run-apply-error/plan") {
      return json({ data: { attributes: { status: "finished" } } });
    }
    if (url === "/api/v2/applies/apply-run-apply-error") {
      return json({
        data: {
          attributes: {
            status: "errored",
            "status-timestamps": {
              "applying-at": "2026-07-29T09:02:00.000Z",
              "errored-at": "2026-07-29T09:03:00.000Z",
            },
          },
        },
      });
    }
    if (url === "/api/v2/plans/plan-run-apply-error/json-output") {
      return json({ resource_changes: [] });
    }
    if (url.endsWith("/cost-estimate")) return json({ data: null });
    // The page reads the raw log protocol now, not the legacy paged
    // collection below: serve the failing log over apply/log so the
    // diagnostics banner has structured errors to present.
    if (url.startsWith("/api/v2/runs/run-apply-error/apply/log")) {
      return phaseLogResponse("Error: resource name already exists\n  on main.tf line 5\n", url);
    }
    if (url.endsWith("/policy-checks")
      || url.endsWith("/run-events")
      || url.endsWith("/comments")) {
      return json({ data: [] });
    }
    return phaseLogOrThrow(url);
  })) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs/run-apply-error"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<RunDetail />}
        />
      </Routes>
    </MemoryRouter>,
  );

  // Accessible name has no space: the status span is separated by margin,
  // not whitespace ("Apply" + "Failed").
  const applyHeading = await view.findByRole("heading", { name: "ApplyFailed" });
  // SAFETY: the heading lives inside a details element; closest() resolves it.
  const applySection = applyHeading.closest("details") as HTMLDetailsElement;
  // Apply errors surface through the same DiagnosticsBanner that warnings
  // use (severity="error"), so the structured error text is rendered by that
  // banner. The banner is the only place errors appear: the raw-log block is
  // gated on there being no structured diagnostics.
  expect(applySection.open).toBeTrue();
  expect(within(applySection).getByText(/Diagnostics/)).toBeTruthy();
  // The DiagnosticsBanner is collapsible and starts closed; expand it so the
  // structured error is visible, then assert it is rendered inside the banner's
  // list (structured diagnostics) rather than leaking only through a raw log.
  const diagnosticsSummary = within(applySection).getByText(/Diagnostics/).closest("summary") as HTMLElement;
  fireEvent.click(diagnosticsSummary);
  const diagnosticList = within(applySection).getByRole("list");
  expect(within(diagnosticList).getByText(/resource name already exists/)).toBeTruthy();
});

test("clears stale activity immediately when navigating to another run", async () => {
  let resolveSecondEvents: ((response: Response) => void) | undefined;
  const secondEvents = new Promise<Response>((resolve): void => {
    resolveSecondEvents = resolve;
  });
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    const runId = url.includes("run-activity-second") ? "run-activity-second" : "run-activity-first";
    if (url === `/api/v2/runs/${runId}`) {
      return json({
        data: {
          id: runId,
          attributes: {
            message: runId === "run-activity-first" ? "First activity run" : "Second activity run",
            status: "planned_and_finished",
            "plan-only": true,
            permissions: { "can-comment": false },
          },
        },
      });
    }
    if (url === `/api/v2/runs/${runId}/run-events`) {
      if (runId === "run-activity-second") return await secondEvents;
      return json({
        data: [{
          id: "first-event",
          attributes: {
            action: "apply",
            "actor-username": "first-user",
            "created-at": "2026-07-29T09:00:00.000Z",
          },
        }],
      });
    }
    if (url === `/api/v2/runs/${runId}/plan`) {
      return json({ data: { attributes: { status: "finished" } } });
    }
    if (url === `/api/v2/applies/apply-${runId}`) {
      return json({ data: { attributes: { status: "pending" } } });
    }
    if (url === `/api/v2/plans/plan-${runId}/json-output`) {
      return json({ resource_changes: [] });
    }
    if (url.endsWith("/cost-estimate")) return json({ data: null });
    if (url.endsWith("/logs") || url.endsWith("/policy-checks") || url.endsWith("/comments")) {
      return json({ data: [] });
    }
    return phaseLogOrThrow(url);
  })) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs/run-activity-first"]}>
      <Link to="/app/acme/workspaces/production/runs/run-activity-second">Next run</Link>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<RunDetail />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("Run confirmed")).toBeTruthy();
  });
  fireEvent.click(view.getByRole("link", { name: "Next run" }));
  await waitFor((): void => {
    expect(view.getByText("Second activity run")).toBeTruthy();
  });
  expect(view.queryByText("Run confirmed")).toBeNull();

  resolveSecondEvents?.(json({ data: [] }));
  await waitFor((): void => {
    expect(view.getByText("No run activity or comments yet.")).toBeTruthy();
  });
});

test("shows a slow-run indicator when duration exceeds the recent baseline", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/runs/run-slow") {
      return json({
        data: {
          id: "run-slow",
          type: "runs",
          attributes: {
            message: "Slow run",
            status: "applied",
            actions: {
              "is-cancelable": false,
              "is-confirmable": false,
              "is-discardable": false,
              "is-force-cancelable": false,
            },
            "created-at": "2026-07-29T10:00:00.000Z",
            "status-timestamps": {
              "planned-at": "2026-07-29T09:00:00.000Z",
              "applied-at": "2026-07-29T09:10:00.000Z",
            },
            "duration-baseline": {
              "duration-seconds": 600,
              "median-duration-seconds": 60,
              "is-slow": true,
            },
          },
        },
      });
    }
    if (url === "/api/v2/runs/run-slow/plan") {
      return json({
        data: { attributes: { status: "finished", "resource-additions": 0, "resource-changes": 0, "resource-destructions": 0, "resource-imports": 0 } },
      });
    }
    if (url === "/api/v2/applies/apply-run-slow") {
      return json({ data: { attributes: { status: "finished", "resource-additions": 0, "resource-changes": 0, "resource-destructions": 0, "resource-imports": 0 } } });
    }
    if (url === "/api/v2/runs/run-slow/logs") return json({ data: [] });
    if (url.endsWith("/cost-estimate")) return json({ data: null });
    return json({ data: [] });
  })) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs/run-slow"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<RunDetail />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText(/Slower than typical/)).toBeTruthy();
  });
  expect(view.getByText(/median 1 minute/)).toBeTruthy();
});