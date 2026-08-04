// Benchmark scenarios: read-heavy TFE API surface exercised by the UI and
// terraform CLI. Each scenario is measured for latency and SQL queries.
import type { BenchContext } from "./seed";

export interface BenchScenario {
  readonly name: string;
  readonly path: (ctx: BenchContext) => string;
  /** Token to use for the request; defaults to the member token. */
  readonly token?: (ctx: BenchContext) => string;
}

export function tokenFor(ctx: BenchContext, token?: (c: BenchContext) => string): string {
  return token === undefined ? ctx.memberToken : token(ctx);
}

export function buildScenarios(): BenchScenario[] {
  return [
    {
      name: "org.detail",
      path: (ctx): string => `/api/v2/organizations/${ctx.orgName}`,
    },
    {
      name: "workspaces.list.50",
      path: (ctx): string => `/api/v2/organizations/${ctx.orgName}/workspaces?page[size]=50`,
    },
    {
      name: "workspaces.list.20",
      path: (ctx): string => `/api/v2/organizations/${ctx.orgName}/workspaces?page[size]=20`,
    },
    {
      name: "workspaces.tag-filter",
      path: (ctx): string => `/api/v2/organizations/${ctx.orgName}/workspaces?search[tags]=env:dev&page[size]=50`,
    },
    {
      name: "workspaces.current-run-filter",
      path: (ctx): string => `/api/v2/organizations/${ctx.orgName}/workspaces?filter[current-run][status]=applied&page[size]=50`,
    },
    {
      name: "workspace.detail",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}`,
    },
    {
      name: "workspace.state-version",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/current-state-version`,
    },
    {
      name: "workspace.vars",
      path: (ctx): string => `/api/v2/workspaces/${ctx.workspaceIds[0]}/vars`,
    },
    {
      name: "runs.list.50",
      path: (ctx): string => `/api/v2/organizations/${ctx.orgName}/runs?page[size]=50`,
    },
    {
      name: "run.detail",
      path: (ctx): string => `/api/v2/runs/${ctx.runIds[0]}`,
    },
    {
      name: "varsets.list",
      path: (ctx): string => `/api/v2/organizations/${ctx.orgName}/varsets`,
      token: (ctx): string => ctx.readerToken,
    },
    {
      name: "teams.list",
      path: (ctx): string => `/api/v2/organizations/${ctx.orgName}/teams`,
    },
    {
      name: "team.detail.include-users",
      path: (ctx): string => `/api/v2/teams/${ctx.teamId}?include=users`,
    },
    {
      name: "org.memberships",
      path: (ctx): string => `/api/v2/organizations/${ctx.orgName}/organization-memberships`,
    },
    {
      name: "project.detail",
      path: (ctx): string => `/api/v2/projects/${ctx.projectIds[0]}`,
      token: (ctx): string => ctx.readerToken,
    },
  ];
}
