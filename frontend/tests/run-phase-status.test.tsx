import { afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useRunView } from "../src/lib/use-run-view";
import { resolvePhaseStatus } from "../src/lib/run-status";
import { auxKindsForStatus } from "../src/lib/run-view-state";
import { resolveStages } from "../src/components/RunStageStrip";
import type { JsonValue } from "../src/lib/json";
import { isString } from "../src/lib/type-guards";
import { RunDetail } from "../src/views/RunDetail";
import { handlePhaseLogs } from "./support/run-log-fixture";

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

test("run lifecycle overrides stale phase snapshots at every handoff", () => {
  expect(resolvePhaseStatus("planning", "plan", {}, "pending")).toBe("running");
  expect(resolvePhaseStatus("needs_confirmation", "plan", {}, "running")).toBe("finished");
  expect(resolvePhaseStatus("applying", "apply", {}, "pending")).toBe("running");
  expect(resolvePhaseStatus("applied", "apply", {}, "running")).toBe("finished");
  expect(resolvePhaseStatus("pre_apply_running", "apply", {}, "pending")).toBe("queued");
  expect(resolvePhaseStatus("post_apply_running", "apply", {}, "finished")).toBe("running");
  expect(resolvePhaseStatus("policy_hard_failed", "plan", {}, "running")).toBe("finished");
  expect(resolvePhaseStatus("errored", "plan", { "planned-at": "2026-09-05T10:00:00Z" }, "running")).toBe("finished");
  expect(resolvePhaseStatus("errored", "apply", { "applying-at": "2026-09-05T10:00:00Z" }, "running")).toBe("errored");
  expect(resolvePhaseStatus("canceled", "plan", { "planning-at": "2026-09-05T10:00:00Z" }, "running")).toBe("canceled");
  expect(resolvePhaseStatus("canceled", "plan", { "pre-plan-running-at": "t1" }, "pending")).toBe("canceled");
  expect(resolvePhaseStatus("errored", "plan", {}, "finished")).toBe("finished");
});

test("phase refreshes include entry, queue and hook transitions", () => {
  for (const status of ["plan_queued", "planning", "pre_plan_running", "post_plan_running"]) {
    expect(auxKindsForStatus(status)).toContain("plan");
  }
  for (const status of ["confirmed", "apply_queued", "applying", "pre_apply_running", "post_apply_running"]) {
    expect(auxKindsForStatus(status)).toContain("apply");
  }
});

test("progress marks a finished plan complete without timestamps and keeps running checks active", () => {
  const options = { planOnly: false, hasPolicyChecks: true };
  expect(resolveStages("needs_confirmation", {}, options).find(stage => stage.id === "plan")?.state).toBe("done");
  expect(resolveStages("policy_checking", {
    "planned-at": "2026-09-05T10:00:00Z", "policy-checking-at": "2026-09-05T10:00:01Z",
  }, options).find(stage => stage.id === "policy")?.state).toBe("active");
  expect(resolveStages("planned", {
    "planned-at": "t3", "policy-checking-at": "t1", "policy-checked-at": "t2",
  }, options).find(stage => stage.id === "policy")?.state).toBe("done");
  expect(resolveStages("planned_and_finished", {}, options).find(stage => stage.id === "apply")?.state).toBe("skipped");
});

test("terminal stages retain completed work and identify the stage that stopped", () => {
  const options = { planOnly: false, hasPolicyChecks: false };
  expect(resolveStages("policy_hard_failed", {}, options).map(stage => [stage.id, stage.state])).toEqual([
    ["queue", "done"], ["plan", "done"], ["policy", "failed"], ["apply", "skipped"],
  ]);
  expect(resolveStages("canceled", { "planning-at": "t1", "planned-at": "t2" }, options)
    .find(stage => stage.id === "plan")?.state).toBe("done");
  expect(resolveStages("canceled", { "planning-at": "t1" }, options)
    .find(stage => stage.id === "plan")?.state).toBe("stopped");
  expect(resolveStages("post_apply_running", { "applied-at": "t1" }, options)
    .find(stage => stage.id === "apply")?.state).toBe("active");
});

test.each(["planning", "applying"])("%s opens the active phase and logs even when its endpoint still reports pending", async status => {
  let currentStatus: string = status;
  const json = (data: JsonValue): Response => Response.json(data);
  // SAFETY: the mock implements the fetch call signature; these tests never use Bun preconnect.
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = isString(input) ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/v2/runs/run-live") return json({ data: {
      id: "run-live", attributes: { status: currentStatus, message: "Live run", "status-timestamps": {} },
    } });
    if (url === "/api/v2/runs/run-live/plan" || url === "/api/v2/applies/apply-run-live") {
      return json({ data: { attributes: { status: "pending" } } });
    }
    const log = handlePhaseLogs(url, "run-live", { plan: "Planning resources…", apply: "Applying resources…" });
    if (log !== null) return log;
    if (url.endsWith("/json-output")) return new Response(null, { status: 204 });
    if (url.endsWith("/cost-estimate")) return json({ data: null });
    return json({ data: [] });
  }) as typeof fetch;
  const view = render(<MemoryRouter initialEntries={["/app/org/workspaces/ws/runs/run-live"]}>
    <Routes><Route path="/app/:orgName/workspaces/:workspaceName/runs/:runId" element={<RunDetail />} /></Routes>
  </MemoryRouter>);
  const phase = status === "planning" ? "Plan" : "Apply";
  await waitFor(() => {
    const heading = view.getByRole("heading", { name: `${phase} Running` });
    expect(heading.closest("details")?.open).toBe(true);
    const rawLog = view.getByText(`Raw ${phase.toLowerCase()} log`).closest("details");
    expect(rawLog?.open).toBe(true);
    expect(rawLog?.textContent).toContain(`${phase === "Plan" ? "Planning" : "Applying"} resources…`);
  });
  if (status === "applying") {
    expect(view.getByRole("heading", { name: "Plan Finished" }).closest("details")?.open).toBe(false);
  }
  const rawLog = view.getByText(`Raw ${phase.toLowerCase()} log`).closest("details");
  if (rawLog === null) throw new Error("Raw log disclosure missing");
  // Explicitly reopen the log: completion must preserve the reader's choice.
  act(() => { rawLog.open = false; fireEvent(rawLog, new Event("toggle")); });
  act(() => { rawLog.open = true; fireEvent(rawLog, new Event("toggle")); });
  currentStatus = status === "planning" ? "planned" : "applied";
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await waitFor(() => {
    expect(view.getByRole("heading", { name: `${phase} Finished` })).toBeTruthy();
    expect(rawLog.open).toBe(true);
  });
});

test("returning to the page refreshes the phase for the newly fetched status", async () => {
  let status = "pending";
  let planReads = 0;
  // SAFETY: the mock implements the fetch call signature; these tests never use Bun preconnect.
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = isString(input) ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/v2/runs/run-refresh") return Response.json({ data: {
      id: "run-refresh", attributes: { status },
    } });
    if (url.endsWith("/plan")) {
      planReads += 1;
      return Response.json({ data: { attributes: { status: status === "planning" ? "running" : "pending" } } });
    }
    const log = handlePhaseLogs(url, "run-refresh", {});
    return log ?? Response.json({ data: null });
  }) as typeof fetch;
  const view = renderHook(() => useRunView("run-refresh"));
  await waitFor(() => expect(view.result.current.state.plan?.attributes.status).toBe("pending"));
  const initialReads = planReads;
  status = "planning";
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await waitFor(() => {
    expect(view.result.current.state.run?.attributes.status).toBe("planning");
    expect(view.result.current.state.plan?.attributes.status).toBe("running");
    expect(planReads).toBeGreaterThan(initialReads);
  });
});
