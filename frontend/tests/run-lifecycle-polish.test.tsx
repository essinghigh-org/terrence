import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { RunDetail } from "../src/views/RunDetail";
import { RunList } from "../src/views/RunList";
import { WorkspaceDetail } from "../src/views/WorkspaceDetail";

const originalFetch = globalThis.fetch;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function CurrentLocation(): React.JSX.Element {
  const location = useLocation();
  return <output aria-label="Current location">{location.pathname}{location.search}</output>;
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
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
      applyBody = typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined;
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
                : {}),
            },
          },
        },
      });
    }
    if (url === "/api/v2/runs/run-polished/logs") {
      return json({
        data: [
          { attributes: { phase: "plan", "output-text": "PLAN_PHASE_ONLY" } },
          { attributes: { phase: "plan", "output-text": "PLAN_PHASE_SECOND" } },
          { attributes: { phase: "apply", "output-text": "APPLY_PHASE_ONLY" } },
          { attributes: { phase: "apply", "output-text": "APPLY_PHASE_SECOND" } },
        ],
      });
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
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

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

  const planSection = view.getByRole("heading", { name: "Plan finished" }).closest("details");
  const applySection = view.getByRole("heading", { name: "Apply needs confirmation" }).closest("details");
  expect(planSection).not.toBeNull();
  expect(applySection).not.toBeNull();
  expect((planSection as HTMLDetailsElement).open).toBeTrue();
  expect((applySection as HTMLDetailsElement).open).toBeFalse();
  const planLog = (planSection as HTMLDetailsElement).querySelector("pre");
  const applyLog = (applySection as HTMLDetailsElement).querySelector("pre");
  expect(planLog?.textContent).toBe("PLAN_PHASE_ONLY\nPLAN_PHASE_SECOND");
  expect(applyLog?.textContent).toBe("APPLY_PHASE_ONLY\nAPPLY_PHASE_SECOND");
  expect(within(planSection as HTMLElement).queryByText("APPLY_PHASE_ONLY")).toBeNull();
  expect(within(planSection as HTMLElement).getByRole("link", { name: "Download raw log" })).toBeTruthy();
  expect(within(planSection as HTMLElement).getByText(/Started/)).toBeTruthy();
  expect(within(planSection as HTMLElement).getByText(/Finished/)).toBeTruthy();
  expect(within(applySection as HTMLElement).queryByText("PLAN_PHASE_ONLY")).toBeNull();
  expect(within(applySection as HTMLElement).getByText("Resources pending")).toBeTruthy();
  expect(view.getByText("Plan & apply duration")).toBeTruthy();
  expect(view.getByText("Less than a minute")).toBeTruthy();
  expect(view.getByText("Resources changed", { selector: "dt" })).toBeTruthy();
  expect(view.getByRole("heading", { name: "Please review the planned changes before continuing" }))
    .toBeTruthy();
  expect(within(planSection as HTMLElement).queryByText("&2 to import")).toBeNull();
  expect(view.getByText("Resources changed", { selector: "dt" }).closest("div")?.textContent).toContain("&2 to import");
  await waitFor((): void => {
    expect(view.getByText("Actions", { selector: "dt" }).closest("div")?.textContent).toContain("2 to invoke");
  });

  expect(view.getByRole("button", { name: "Review & apply" })).toBeTruthy();
  expect(view.getByRole("link", { name: "New run" }).getAttribute("href"))
    .toBe("/app/acme/workspaces/production/runs?new-run=true");
  expect(view.getAllByRole("navigation", { name: "Breadcrumb" })).toHaveLength(1);
  expect(view.getByLabelText("Copy workspace ID")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Discard run" })).toBeNull();
  expect(view.queryByRole("button", { name: "Cancel run" })).toBeNull();
  expect(view.queryByRole("button", { name: "Force cancel" })).toBeNull();

  const activitySection = view.getByRole("heading", { name: "Activity" }).closest("section");
  const commentsSection = view.getByRole("heading", { name: "Comments" }).closest("section");
  expect(within(activitySection as HTMLElement).getByText("Run confirmed")).toBeTruthy();
  expect(within(activitySection as HTMLElement).getByText("Needs confirmation → Confirmed")).toBeTruthy();
  expect(within(activitySection as HTMLElement).getByText("essinghigh")).toBeTruthy();
  expect(within(commentsSection as HTMLElement).getByText("essinghigh")).toBeTruthy();
  expect(within(commentsSection as HTMLElement).getByText("Approved for production")).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: "Review & apply" }));
  expect(view.getByRole("heading", { name: "Confirm apply" })).toBeTruthy();
  const actionComment = view.getByLabelText("Optional comment") as HTMLTextAreaElement;
  fireEvent.input(actionComment, {
    target: { value: "Approved after reviewing the dependency graph" },
  });
  expect(actionComment.value).toBe("Approved after reviewing the dependency graph");
  fireEvent.click(view.getByRole("button", { name: "Confirm & apply" }));
  await waitFor((): void => {
    expect(view.getByRole("heading", { name: "Apply finished" })).toBeTruthy();
  });
  expect(applyBody).toMatchObject({
    data: { attributes: { comment: "Approved after reviewing the dependency graph" } },
  });
  const finishedApply = view.getByRole("heading", { name: "Apply finished" }).closest("details");
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
      if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
      createBody = JSON.parse(init.body) as unknown;
      return json({ data: { id: "run-plan-only" } }, 201);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

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
      if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
      createBody = JSON.parse(init.body) as unknown;
      return json({ data: { id: "run-cloned" } }, 201);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

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
  expect((view.getByLabelText("Run name") as HTMLInputElement).value).toBe("Targeted DB migration");
  expect((view.getByRole("radio", { name: "Plan only" }) as HTMLInputElement).checked).toBe(true);
  expect((view.getByRole("checkbox", { name: "Destroy infrastructure" }) as HTMLInputElement).checked).toBe(true);
  expect((view.getByLabelText("Target addresses") as HTMLInputElement).value).toBe("aws_instance.db");
  expect((view.getByLabelText("Replace addresses") as HTMLInputElement).value)
    .toBe("aws_instance.web, aws_instance.api");

  fireEvent.click(view.getByRole("button", { name: "Start run" }));
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
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    if (requestUrl(input) === "/api/v2/workspaces/ws-1/runs" || requestUrl(input) === "/api/v2/workspaces/ws-1/runs?sort=-created-at") return json({ data: [] });
    throw new Error(`Unexpected request: ${requestUrl(input)}`);
  }) as typeof fetch;

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
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    if (requestUrl(input) === "/api/v2/workspaces/ws-readonly/runs" || requestUrl(input) === "/api/v2/workspaces/ws-readonly/runs?sort=-created-at") return json({ data: [] });
    throw new Error(`Unexpected request: ${requestUrl(input)}`);
  }) as typeof fetch;

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
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
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
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

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
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
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
    if (url.endsWith("/policy-checks")
      || url.endsWith("/run-events")
      || url.endsWith("/comments")) {
      return json({ data: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

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

  const applyHeading = await view.findByRole("heading", { name: "Apply errored" });
  const applySection = applyHeading.closest("details") as HTMLDetailsElement;
  const diagnostics = within(applySection).getByRole("heading", { name: "Diagnostics" }).closest("section");
  expect(applySection.open).toBeTrue();
  expect(diagnostics).not.toBeNull();
  expect(within(diagnostics as HTMLElement).getByText(/resource name already exists/)).toBeTruthy();
  expect(within(applySection).getByText(/Errored/)).toBeTruthy();
});

test("clears stale activity immediately when navigating to another run", async () => {
  let resolveSecondEvents: ((response: Response) => void) | undefined;
  const secondEvents = new Promise<Response>((resolve): void => {
    resolveSecondEvents = resolve;
  });
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
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
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

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
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
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
  }) as typeof fetch;

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
