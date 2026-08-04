// Benchmark seed: builds a realistic org (projects, workspaces, tags, teams,
// runs, state versions, variable sets) inside the temp database so every
// scenario exercises the same shapes the UI and TFE clients hit.
//
// Deliberately shaped to stress the expensive permission path: the bench user
// is an org MEMBER via a team (not owner), so workspace authorization must
// walk team memberships + team_workspaces for every permission level.
import { createHash, randomUUID } from "node:crypto";
import { db } from "../src/db";
import {
  apiTokens,
  organizations,
  organizationMemberships,
  projects,
  runs,
  stateVersions,
  teams,
  teamMemberships,
  teamWorkspaces,
  users,
  variableSets,
  variableSetProjects,
  variableSetVariables,
  variableSetWorkspaces,
  workspaces,
  workspaceTags,
} from "../src/db/schema";

export interface BenchContext {
  orgId: string;
  orgName: string;
  ownerUserId: string;
  memberUserId: string;
  memberToken: string;
  // Reader principal: a separate team with read-varsets/read-projects grants
  // (those cascade into read-workspaces, which would short-circuit the
  // workspace permission path the member token exercises — so it gets its own
  // token and is only used for varsets/projects scenarios).
  readerToken: string;
  teamId: string;
  projectIds: string[];
  workspaceIds: string[];
  runIds: string[];
  variableSetIds: string[];
}

export const BENCH_ORG = "bench-org";
export const WORKSPACE_COUNT = 50;
export const RUNS_PER_WORKSPACE = 3;
export const PROJECT_COUNT = 5;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export async function seedBenchmark(): Promise<BenchContext> {
  const now = Date.now();
  const orgId = `org-${randomUUID()}`;
  const ownerUserId = `user-${randomUUID()}`;
  const memberUserId = `user-${randomUUID()}`;
  const readerUserId = `user-${randomUUID()}`;
  const memberToken = `terrence-bench-${randomUUID()}`;
  const readerToken = `terrence-bench-${randomUUID()}`;

  await db.insert(users).values([
    { id: ownerUserId, username: "bench-owner", passwordHash: "unused-hash" },
    { id: memberUserId, username: "bench-member", passwordHash: "unused-hash" },
    { id: readerUserId, username: "bench-reader", passwordHash: "unused-hash" },
  ]);
  await db.insert(organizations).values({ id: orgId, name: BENCH_ORG });
  await db.insert(organizationMemberships).values([
    { id: `om-${randomUUID()}`, userId: ownerUserId, orgId, role: "owner", status: "active" },
    { id: `om-${randomUUID()}`, userId: memberUserId, orgId, role: "member", status: "active" },
    { id: `om-${randomUUID()}`, userId: readerUserId, orgId, role: "member", status: "active" },
  ]);
  await db.insert(apiTokens).values([
    {
      id: `tok-${randomUUID()}`,
      token: sha256(memberToken),
      userId: memberUserId,
      orgId: null,
      teamId: null,
      description: "benchmark member token",
      scopes: null,
      createdAt: now,
      expiresAt: null,
      lastUsedAt: null,
    },
    {
      id: `tok-${randomUUID()}`,
      token: sha256(readerToken),
      userId: readerUserId,
      orgId: null,
      teamId: null,
      description: "benchmark reader token",
      scopes: null,
      createdAt: now,
      expiresAt: null,
      lastUsedAt: null,
    },
  ]);

  const projectIds = Array.from({ length: PROJECT_COUNT }, (): string => `prj-${randomUUID()}`);
  await db.insert(projects).values(projectIds.map((id, index): typeof projects.$inferInsert => ({
    id,
    orgId,
    name: `project-${index + 1}`,
    isDefault: index === 0,
  })));

  const workspaceIds = Array.from({ length: WORKSPACE_COUNT }, (): string => `ws-${randomUUID()}`);
  await db.insert(workspaces).values(workspaceIds.map((id, index): typeof workspaces.$inferInsert => ({
    id,
    orgId,
    projectId: projectIds[index % PROJECT_COUNT],
    name: `workspace-${String(index + 1).padStart(2, "0")}`,
    createdAt: now - (WORKSPACE_COUNT - index) * 60_000,
  })));

  const tagValues = ["env:dev", "env:prod", "team:core", "team:platform"];
  const tagRows = workspaceIds.flatMap((id, index): typeof workspaceTags.$inferInsert[] => {
    const first = tagValues[index % tagValues.length];
    const second = tagValues[(index + 2) % tagValues.length];
    return [
      { id: `tag-${randomUUID()}`, workspaceId: id, key: first.split(":")[0], value: first.split(":")[1] },
      { id: `tag-${randomUUID()}`, workspaceId: id, key: second.split(":")[0], value: second.split(":")[1] },
    ];
  });
  await db.insert(workspaceTags).values(tagRows);

  const teamId = `team-${randomUUID()}`;
  await db.insert(teams).values({
    id: teamId,
    orgId,
    name: "bench-team",
    organizationAccess: {},
    visibility: "organization",
  });
  await db.insert(teamMemberships).values({
    id: `tm-${randomUUID()}`,
    teamId,
    userId: memberUserId,
  });
  await db.insert(teamWorkspaces).values(workspaceIds.map((id): typeof teamWorkspaces.$inferInsert => ({
    id: `tw-${randomUUID()}`,
    teamId,
    workspaceId: id,
    access: "write",
    permissions: null,
  })));

  // Reader team: read-varsets + read-projects OR the workspace read shortcut,
  // so it must ONLY ever be used for the varsets/projects scenarios.
  const readerTeamId = `team-${randomUUID()}`;
  await db.insert(teams).values({
    id: readerTeamId,
    orgId,
    name: "bench-readers",
    organizationAccess: { "read-varsets": true, "read-projects": true },
    visibility: "organization",
  });
  await db.insert(teamMemberships).values({
    id: `tm-${randomUUID()}`,
    teamId: readerTeamId,
    userId: readerUserId,
  });

  // Runs: 3 per workspace, newest first per workspace, terminal statuses so a
  // (disabled) worker would have nothing to do. Latest run gets an "applied"
  // status; earlier ones "planned_and_finished".
  const runIds: string[] = [];
  const runRows: (typeof runs.$inferInsert)[] = [];
  const stateRows: (typeof stateVersions.$inferInsert)[] = [];
  workspaceIds.forEach((workspaceId, wsIndex): void => {
    for (let i = 0; i < RUNS_PER_WORKSPACE; i += 1) {
      const runId = `run-${randomUUID()}`;
      runIds.push(runId);
      runRows.push({
        id: runId,
        workspaceId,
        status: i === 0 ? "applied" : "planned_and_finished",
        message: `bench run ${i + 1}`,
        createdBy: memberUserId,
        createdAt: now - (wsIndex * 3 + i) * 30_000,
      });
    }
    const latestRunId = runIds[runIds.length - 1];
    stateRows.push({
      id: `sv-${randomUUID()}`,
      workspaceId,
      serial: 1,
      status: "finalized",
      intermediate: false,
      runId: latestRunId,
      createdAt: now - wsIndex * 30_000,
      jsonState: JSON.stringify({ resources: [{ type: "aws_instance", name: "bench", count: 3 }] }),
      statePayload: "state-payload-bytes",
    });
  });
  await db.insert(runs).values(runRows);
  await db.insert(stateVersions).values(stateRows);

  const variableSetIds: string[] = [];
  const vsRows: (typeof variableSets.$inferInsert)[] = [
    { id: `vs-${randomUUID()}`, orgId, name: "global-vars", global: true, priority: false },
    { id: `vs-${randomUUID()}`, orgId, parentProjectId: projectIds[0], name: "project-one-vars", global: false },
    { id: `vs-${randomUUID()}`, orgId, parentProjectId: projectIds[1], name: "project-two-vars", global: false },
  ];
  vsRows.forEach((row): void => { variableSetIds.push(row.id as string); });
  await db.insert(variableSets).values(vsRows);

  await db.insert(variableSetWorkspaces).values(workspaceIds.map((id): typeof variableSetWorkspaces.$inferInsert => ({
    id: `vsw-${randomUUID()}`,
    variableSetId: variableSetIds[0],
    workspaceId: id,
  })));
  await db.insert(variableSetProjects).values({
    id: `vsp-${randomUUID()}`,
    variableSetId: variableSetIds[1],
    projectId: projectIds[0],
  });
  const vsVariableRows = variableSetIds.flatMap((setId, setIndex): typeof variableSetVariables.$inferInsert[] =>
    ["region", "instance_type", "ami_id", "tags"].slice(0, 3 + setIndex).map((key): typeof variableSetVariables.$inferInsert => ({
      id: `vsv-${randomUUID()}`,
      variableSetId: setId,
      key,
      value: `value-${key}-${setIndex}`,
      category: "terraform",
      sensitive: false,
    })));
  await db.insert(variableSetVariables).values(vsVariableRows);

  return {
    orgId,
    orgName: BENCH_ORG,
    ownerUserId,
    memberUserId,
    memberToken,
    readerToken,
    teamId,
    projectIds,
    workspaceIds,
    runIds,
    variableSetIds,
  };
}
