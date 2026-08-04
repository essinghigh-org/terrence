// Benchmark seed: builds a realistic org (projects, workspaces, tags, teams,
// runs, state versions, variable sets, configuration versions, registry
// modules, policy sets) inside the temp database so every scenario exercises
// the same shapes the UI and TFE clients hit.
//
// Deliberately shaped to stress the expensive permission path: the bench user
// is an org MEMBER via a team (not owner), so workspace authorization must
// walk team memberships + team_workspaces for every permission level.
import { createHash, randomUUID } from "node:crypto";
import { db } from "../src/db";
import {
  apiTokens,
  auditLogs,
  configurationVersions,
  logs,
  organizations,
  organizationMemberships,
  policies,
  policySets,
  policySetWorkspaces,
  projects,
  registryModuleVersions,
  registryModules,
  runComments,
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

export type BenchContext = {
  orgId: string;
  orgName: string;
  ownerUserId: string;
  ownerToken: string;
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
  stateVersionId: string;
  configurationVersionId: string;
  planId: string;
  applyId: string;
  moduleId: string;
  policySetId: string;
  policyId: string;
}

export const BENCH_ORG = "bench-org";
export const WORKSPACE_COUNT = 50;
export const RUNS_PER_WORKSPACE = 3;
export const PROJECT_COUNT = 5;
export const MODULE_COUNT = 5;
export const POLICY_SET_COUNT = 3;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export async function seedBenchmark(): Promise<BenchContext> {
  const now = Date.now();
  const orgId = `org-${randomUUID()}`;
  const ownerUserId = `user-${randomUUID()}`;
  const memberUserId = `user-${randomUUID()}`;
  const readerUserId = `user-${randomUUID()}`;
  const ownerToken = `terrence-bench-${randomUUID()}`;
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
      token: sha256(ownerToken),
      userId: ownerUserId,
      orgId: null,
      teamId: null,
      description: "benchmark owner token",
      scopes: null,
      createdAt: now,
      expiresAt: null,
      lastUsedAt: null,
    },
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
    createdAt: now,
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
    createdAt: now,
  });
  await db.insert(teamMemberships).values({
    id: `tm-${randomUUID()}`,
    teamId,
    userId: memberUserId,
    createdAt: now,
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
    createdAt: now,
  });
  await db.insert(teamMemberships).values({
    id: `tm-${randomUUID()}`,
    teamId: readerTeamId,
    userId: readerUserId,
    createdAt: now,
  });

  // Configuration versions: one per workspace, uploaded; the newest run of
  // each workspace is linked to it so originsForRuns() has real data.
  const configurationVersionIds = workspaceIds.map((workspaceId): string => {
    const id = `cv-${randomUUID()}`;
    void workspaceId;
    return id;
  });
  await db.insert(configurationVersions).values(configurationVersionIds.map((id, index): typeof configurationVersions.$inferInsert => ({
    id,
    workspaceId: workspaceIds[index]!,
    status: "uploaded",
    autoQueueRuns: true,
    source: "tfe-api",
    createdAt: now - (index * RUNS_PER_WORKSPACE + 1) * 30_000,
    statusTimestamps: { uploadedAt: new Date(now - (index * RUNS_PER_WORKSPACE + 1) * 30_000).toISOString(), archivedAt: new Date(now).toISOString() },
  })));

  // Runs: 3 per workspace, newest first per workspace, terminal statuses so a
  // (disabled) worker would have nothing to do. Latest run gets an "applied"
  // status; earlier ones "planned_and_finished".
  const runIds: string[] = [];
  const runRows: (typeof runs.$inferInsert)[] = [];
  const stateRows: (typeof stateVersions.$inferInsert)[] = [];
  let firstStateVersionId = "";
  workspaceIds.forEach((workspaceId, wsIndex): void => {
    for (let i = 0; i < RUNS_PER_WORKSPACE; i += 1) {
      const runId = `run-${randomUUID()}`;
      runIds.push(runId);
      runRows.push({
        id: runId,
        workspaceId,
        configurationVersionId: i === 0 ? configurationVersionIds[wsIndex]! : null,
        status: i === 0 ? "applied" : "planned_and_finished",
        message: `bench run ${i + 1}`,
        createdBy: memberUserId,
        createdAt: now - (wsIndex * RUNS_PER_WORKSPACE + i) * 30_000,
      });
    }
    // The newest run of this workspace is the FIRST one pushed for it
    // (i === 0 has the largest createdAt), which sits RUNS_PER_WORKSPACE
    // entries before the end of runIds.
    const latestRunId = runIds[runIds.length - RUNS_PER_WORKSPACE]!;
    const stateVersionId = `sv-${randomUUID()}`;
    if (wsIndex === 0) firstStateVersionId = stateVersionId;
    stateRows.push({
      id: stateVersionId,
      workspaceId,
      serial: 1,
      status: "finalized",
      intermediate: false,
      runId: latestRunId,
      createdAt: now - wsIndex * 30_000,
      jsonState: JSON.stringify({ resources: [{ type: "aws_instance", name: "bench", count: 3 }] }),
      statePayload: "state-payload-bytes",
      jsonStateOutputs: JSON.stringify({ instance_id: { value: "i-abcdef123456789" } }),
      terraformVersion: "1.9.0",
    });
  });
  // Chunk the bulk inserts so the seed scales if the workspace/run constants
  // are raised (SQLite bound-parameter limit per statement).
  const CHUNK_SIZE = 200;
  const insertInChunks = async <T>(insert: (rows: T[]) => Promise<unknown>, rows: T[]): Promise<void> => {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      await insert(rows.slice(i, i + CHUNK_SIZE));
    }
  };
  await insertInChunks(async (rows): Promise<unknown> => db.insert(runs).values(rows), runRows);
  await insertInChunks(async (rows): Promise<unknown> => db.insert(stateVersions).values(rows), stateRows);

  // Logs + comments + audit events for the first run, so log/comment/event
  // scenarios return real content.
  const firstRunId = runIds[0]!;
  await db.insert(logs).values([
    { id: `log-${randomUUID()}`, runId: firstRunId, phase: "plan", outputText: "Terraform will perform the following actions:\n  # aws_instance.bench\n  + resource \"aws_instance\" \"bench\" {\n      + ami = \"ami-123\"\n    }\nPlan: 1 to add, 0 to change, 0 to destroy.\n", createdAt: now },
    { id: `log-${randomUUID()}`, runId: firstRunId, phase: "apply", outputText: "Apply complete! Resources: 1 added.\n", createdAt: now },
  ]);
  await db.insert(runComments).values([
    { id: `rc-${randomUUID()}`, runId: firstRunId, userId: memberUserId, body: "Benchmark seed comment", createdAt: now },
  ]);
  await db.insert(auditLogs).values([
    { id: `al-${randomUUID()}`, orgId, userId: memberUserId, action: "create", resourceType: "runs", resourceId: firstRunId, details: { fromStatus: undefined, toStatus: "applied", status: "applied", source: "tfe-api", triggerReason: "manual" }, createdAt: now },
    { id: `al-${randomUUID()}`, orgId, userId: memberUserId, action: "update", resourceType: "runs", resourceId: firstRunId, details: { fromStatus: "pending", toStatus: "planning", status: "planning" }, createdAt: now + 1 },
  ]);

  // Registry modules + versions.
  const moduleIds = Array.from({ length: MODULE_COUNT }, (): string => `mod-${randomUUID()}`);
  await db.insert(registryModules).values(moduleIds.map((id, index): typeof registryModules.$inferInsert => ({
    id,
    orgId,
    namespace: "bench-ns",
    name: `module-${index + 1}`,
    provider: "aws",
    createdAt: now,
  })));
  const moduleVersionRows = moduleIds.map((id, index): typeof registryModuleVersions.$inferInsert => ({
    id: `rmv-${randomUUID()}`,
    moduleId: id,
    version: `1.0.${index}`,
    status: "ok",
    createdAt: now,
  }));
  await insertInChunks(async (rows): Promise<unknown> => db.insert(registryModuleVersions).values(rows), moduleVersionRows);

  // Policy sets + policies + workspace links.
  const policySetIds = Array.from({ length: POLICY_SET_COUNT }, (): string => `ps-${randomUUID()}`);
  await db.insert(policySets).values(policySetIds.map((id, index): typeof policySets.$inferInsert => ({
    id,
    orgId,
    name: `policy-set-${index + 1}`,
    kind: "sentinel",
    global: false,
    overridable: true,
    createdAt: now,
  })));
  await db.insert(policySetWorkspaces).values(policySetIds.map((id, index): typeof policySetWorkspaces.$inferInsert => ({
    id: `psw-${randomUUID()}`,
    policySetId: id,
    workspaceId: workspaceIds[index]!,
  })));
  const policyRows = policySetIds.flatMap((setId, setIndex): typeof policies.$inferInsert[] => [
    { id: `pol-${randomUUID()}`, policySetId: setId, name: `policy-${setIndex + 1}-a`, enforcementLevel: "soft-mandatory", createdAt: now },
    { id: `pol-${randomUUID()}`, policySetId: setId, name: `policy-${setIndex + 1}-b`, enforcementLevel: "advisory", createdAt: now },
  ]);
  await insertInChunks(async (rows): Promise<unknown> => db.insert(policies).values(rows), policyRows);
  const firstPolicyId = policyRows[0]!.id;

  const variableSetIds = Array.from({ length: 3 }, (): string => `vs-${randomUUID()}`);
  const vsRows: (typeof variableSets.$inferInsert)[] = [
    { id: variableSetIds[0]!, orgId, name: "global-vars", global: true, priority: false },
    { id: variableSetIds[1]!, orgId, parentProjectId: projectIds[0], name: "project-one-vars", global: false, priority: false },
    { id: variableSetIds[2]!, orgId, parentProjectId: projectIds[1], name: "project-two-vars", global: false, priority: false },
  ];
  await db.insert(variableSets).values(vsRows);

  await db.insert(variableSetWorkspaces).values(workspaceIds.map((id): typeof variableSetWorkspaces.$inferInsert => ({
    id: `vsw-${randomUUID()}`,
    variableSetId: variableSetIds[0]!,
    workspaceId: id,
  })));
  await db.insert(variableSetProjects).values({
    id: `vsp-${randomUUID()}`,
    variableSetId: variableSetIds[1]!,
    projectId: projectIds[0]!,
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
    ownerToken,
    memberUserId,
    memberToken,
    readerToken,
    teamId,
    projectIds,
    workspaceIds,
    runIds,
    variableSetIds,
    stateVersionId: firstStateVersionId,
    configurationVersionId: configurationVersionIds[0]!,
    planId: `plan-${firstRunId}`,
    applyId: `apply-${firstRunId}`,
    moduleId: moduleIds[0]!,
    policySetId: policySetIds[0]!,
    policyId: firstPolicyId,
  };
}