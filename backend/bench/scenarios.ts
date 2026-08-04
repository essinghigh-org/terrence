// Benchmark scenarios: read-heavy TFE API surface exercised by the UI and
// terraform CLI, plus representative write paths. Each scenario is measured
// for latency and SQL queries.
import type { BenchContext } from "./seed";

export type BenchScenario = {
  readonly name: string;
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** `iteration` is provided so create-style scenarios can target a fresh resource. */
  readonly path: (ctx: BenchContext, iteration: number) => string;
  /** Token to use for the request; defaults to the member token. */
  readonly token?: (ctx: BenchContext) => string;
  readonly body?: (ctx: BenchContext, iteration: number) => unknown;
  readonly expectedStatus?: number;
}

export function tokenFor(ctx: BenchContext, token?: (c: BenchContext) => string): string {
  return token === undefined ? ctx.memberToken : token(ctx);
}

const read = (path: string, token?: (ctx: BenchContext) => string): BenchScenario => ({
  name: path,
  path: (): string => path,
  ...(token === undefined ? {} : { token }),
});

export function buildScenarios(): BenchScenario[] {
  return [
    // --- Account & org surface ---
    read("/api/v2/account/details", (ctx): string => ctx.memberToken),
    read("/api/v2/account/sessions", (ctx): string => ctx.memberToken),
    read("/api/v2/account/mfa", (ctx): string => ctx.memberToken),
    read("/api/v2/organizations"),
    read("/api/v2/organizations/bench-org"),
    read("/api/v2/organizations/bench-org/entitlement-set"),
    read("/api/v2/organizations/bench-org/capacity"),
    read("/api/v2/organizations/bench-org/tags"),
    read("/api/v2/organizations/bench-org/ssh-keys", (ctx): string => ctx.ownerToken),
    read("/api/v2/organizations/bench-org/agent-pools", (ctx): string => ctx.ownerToken),
    read("/api/v2/organizations/bench-org/oauth-clients", (ctx): string => ctx.ownerToken),
    read("/api/v2/organizations/bench-org/run-tasks", (ctx): string => ctx.ownerToken),
    read("/api/v2/organizations/bench-org/policy-sets", (ctx): string => ctx.ownerToken),
    read("/api/v2/organizations/bench-org/registry-modules"),
    read("/api/v2/organizations/bench-org/registry-providers"),
    read("/api/v2/organizations/bench-org/users", (ctx): string => ctx.ownerToken),
    read("/api/v2/organizations/bench-org/roles", (ctx): string => ctx.ownerToken),
    read("/api/v2/organizations/bench-org/organization-memberships", (ctx): string => ctx.ownerToken),
    read("/api/v2/organizations/bench-org/teams", (ctx): string => ctx.ownerToken),
    read("/api/v2/organizations/bench-org/projects", (ctx): string => ctx.ownerToken),

    // --- Workspaces: list variants ---
    read("/api/v2/organizations/bench-org/workspaces?page[size]=20"),
    read("/api/v2/organizations/bench-org/workspaces?page[size]=50"),
    read("/api/v2/organizations/bench-org/workspaces?page[size]=100"),
    read("/api/v2/organizations/bench-org/workspaces?page[size]=50&page[number]=2"),
    read("/api/v2/organizations/bench-org/workspaces?search[name]=workspace-"),
    read("/api/v2/organizations/bench-org/workspaces?search[tags]=env:dev&page[size]=50"),
    read("/api/v2/organizations/bench-org/workspaces?filter[current-run][status]=applied&page[size]=50"),
    {
      name: "/api/v2/organizations/bench-org/workspaces?filter[project][id]=<project-0>",
      path: (ctx): string => `/api/v2/organizations/bench-org/workspaces?filter[project][id]=${ctx.projectIds[0]}`,
    },

    // --- Workspace detail & relationships ---
    {
      name: "workspace.detail",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}`,
    },
    {
      name: "workspace.by-name",
      path: (): string => "/api/v2/organizations/bench-org/workspaces/workspace-01",
    },
    {
      name: "workspace.state-version",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/current-state-version`,
    },
    {
      name: "workspace.state-version-outputs",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/current-state-version-outputs`,
    },
    {
      name: "workspace.vars",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/vars`,
    },
    {
      name: "workspace.runs",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/runs`,
    },
    {
      name: "workspace.state-versions",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/state-versions`,
    },
    {
      name: "workspace.configuration-versions",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/configuration-versions`,
    },
    {
      name: "workspace.tag-bindings",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/tag-bindings`,
    },
    {
      name: "workspace.remote-state-consumers",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/relationships/remote-state-consumers`,
      token: (ctx): string => ctx.ownerToken,
    },
    {
      name: "workspace.dependency-graph",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/dependency-graph`,
    },
    {
      name: "workspace.resources",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/resources`,
    },
    {
      name: "workspace.notifications",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/notification-configurations`,
    },
    {
      name: "workspace.policy-sets",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/policy-sets`,
    },
    {
      name: "workspace.run-triggers",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/run-triggers`,
    },
    {
      name: "workspace.change-requests",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/change-requests`,
    },

    // --- Runs ---
    read("/api/v2/organizations/bench-org/runs?page[size]=20"),
    read("/api/v2/organizations/bench-org/runs?page[size]=50"),
    read("/api/v2/organizations/bench-org/runs?page[size]=50&page[number]=2"),
    read("/api/v2/organizations/bench-org/runs/queue"),
    {
      name: "run.detail",
      path: (ctx): string => `/api/v2/runs/${ctx.runIds[0]}`,
    },
    {
      name: "run.plan",
      path: (ctx): string => `/api/v2/runs/${ctx.runIds[0]}/plan`,
    },
    {
      name: "run.apply",
      path: (ctx): string => `/api/v2/runs/${ctx.runIds[0]}/apply`,
    },
    {
      name: "run.comments",
      path: (ctx): string => `/api/v2/runs/${ctx.runIds[0]}/comments`,
    },
    {
      name: "run.run-events",
      path: (ctx): string => `/api/v2/runs/${ctx.runIds[0]}/run-events`,
    },
    {
      name: "run.logs",
      path: (ctx): string => `/api/v2/runs/${ctx.runIds[0]}/logs`,
    },
    {
      name: "run.plan.log",
      path: (ctx): string => `/api/v2/runs/${ctx.runIds[0]}/plan/log`,
    },
    {
      name: "run.check-results",
      path: (ctx): string => `/api/v2/runs/${ctx.runIds[0]}/check-results`,
    },
    {
      name: "run.task-stages",
      path: (ctx): string => `/api/v2/runs/${ctx.runIds[0]}/task-stages`,
    },
    {
      name: "plan.detail",
      path: (ctx): string => `/api/v2/plans/${ctx.planId}`,
    },
    {
      name: "apply.detail",
      path: (ctx): string => `/api/v2/applies/${ctx.applyId}`,
    },

    // --- State versions & configuration versions ---
    {
      name: "state-version.detail",
      path: (ctx): string => `/api/v2/state-versions/${ctx.stateVersionId}`,
    },
    {
      name: "state-version.outputs",
      path: (ctx): string => `/api/v2/state-versions/${ctx.stateVersionId}/outputs`,
    },
    {
      name: "configuration-version.detail",
      path: (ctx): string => `/api/v2/configuration-versions/${ctx.configurationVersionId}`,
    },

    // --- Teams & projects ---
    {
      name: "team.detail",
      path: (ctx): string => `/api/v2/teams/${ctx.teamId}`,
    },
    {
      name: "team.detail.include-users",
      path: (ctx): string => `/api/v2/teams/${ctx.teamId}?include=users`,
    },
    {
      name: "project.detail",
      path: (ctx): string => `/api/v2/projects/${ctx.projectIds[0]}`,
      token: (ctx): string => ctx.readerToken,
    },
    {
      name: "project.effective-tag-bindings",
      path: (ctx): string => `/api/v2/projects/${ctx.projectIds[0]}/effective-tag-bindings`,
      token: (ctx): string => ctx.readerToken,
    },
    {
      name: "project.notifications",
      path: (ctx): string => `/api/v2/projects/${ctx.projectIds[0]}/notification-configurations`,
      token: (ctx): string => ctx.readerToken,
    },

    // --- Varsets ---
    {
      name: "varsets.list",
      path: (): string => "/api/v2/organizations/bench-org/varsets",
      token: (ctx): string => ctx.readerToken,
    },
    {
      name: "varset.detail",
      path: (ctx): string => `/api/v2/varsets/${ctx.variableSetIds[0]}`,
      token: (ctx): string => ctx.readerToken,
    },
    {
      name: "varset.relationships.vars",
      path: (ctx): string => `/api/v2/varsets/${ctx.variableSetIds[0]}/relationships/vars`,
      token: (ctx): string => ctx.readerToken,
    },

    // --- Registry & policies ---
    {
      name: "registry-module.detail",
      path: (ctx): string => `/api/v2/registry-modules/${ctx.moduleId}/versions`,
    },
    {
      name: "policy-set.detail",
      path: (ctx): string => `/api/v2/policy-sets/${ctx.policySetId}`,
      token: (ctx): string => ctx.ownerToken,
    },
    {
      name: "policy-set.policies",
      path: (ctx): string => `/api/v2/policy-sets/${ctx.policySetId}/policies`,
      token: (ctx): string => ctx.ownerToken,
    },
    {
      name: "policy.detail",
      path: (ctx): string => `/api/v2/policies/${ctx.policyId}`,
      token: (ctx): string => ctx.ownerToken,
    },

    // --- Explorer (UI dashboard view) ---
    read("/api/v2/organizations/bench-org/explorer?type=workspaces&page[size]=50"),

    // --- Write paths (owner token; unique names per iteration) ---
    {
      name: "workspace.create",
      method: "POST",
      path: (): string => "/api/v2/organizations/bench-org/workspaces",
      token: (ctx): string => ctx.ownerToken,
      body: (_ctx, iteration): unknown => ({
        data: {
          type: "workspaces",
          attributes: { name: `bench-created-${iteration}`, "execution-mode": "remote" },
        },
      }),
      expectedStatus: 201,
    },
    {
      name: "workspace.lock-toggle",
      method: "POST",
      token: (ctx): string => ctx.ownerToken,
      path: (ctx, iteration): string => {
        const action = iteration % 2 === 0 ? "lock" : "unlock";
        return `/api/v2/workspaces/${ctx.workspaceIds[1]}/actions/${action}`;
      },
      body: (): unknown => ({ data: { type: "workspace-locks", attributes: { reason: "bench lock" } } }),
    },
    {
      name: "var.create",
      method: "POST",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/vars`,
      token: (ctx): string => ctx.ownerToken,
      body: (_ctx, iteration): unknown => ({
        data: { type: "vars", attributes: { key: `bench_var_${iteration}`, value: "1", category: "terraform" } },
      }),
      expectedStatus: 201,
    },
    {
      name: "run.create",
      method: "POST",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/runs`,
      token: (ctx): string => ctx.ownerToken,
      body: (ctx): unknown => ({
        data: {
          type: "runs",
          attributes: { message: "bench run" },
          relationships: { "configuration-version": { data: { type: "configuration-versions", id: ctx.configurationVersionId } } },
        },
      }),
      expectedStatus: 201,
    },
    {
      name: "team.create",
      method: "POST",
      path: (): string => "/api/v2/organizations/bench-org/teams",
      token: (ctx): string => ctx.ownerToken,
      body: (_ctx, iteration): unknown => ({
        data: { type: "teams", attributes: { name: `bench-team-${iteration}` } },
      }),
      expectedStatus: 201,
    },
  ];
}
