import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import {
  organizations,
  projects,
  workspaces,
  runs,
  policies,
  policySets,
  policyChecks,
  policySetTagSelectors,
  workspaceTags,
  projectTags,
  policySetWorkspaces,
  policySetExclusions,
  policySetProjectExclusions,
} from "../../src/db/schema";
import { isPolicyEvaluationCheckpoint } from "../../src/lib/workspace-policy-gate";
import { runPolicyChecks } from "../../src/worker";

const cases = [
  {
    name: "any matching inclusion",
    logic: "any",
    tags: [["env", "prod"]],
    selectors: [
      ["env", "prod", false],
      ["team", "ops", false],
    ],
    expected: true,
  },
  {
    name: "all requires every inclusion",
    logic: "all",
    tags: [["env", "prod"]],
    selectors: [
      ["env", "prod", false],
      ["team", "ops", false],
    ],
    expected: false,
  },
  {
    name: "all matching inclusions",
    logic: "all",
    tags: [
      ["env", "prod"],
      ["team", "ops"],
    ],
    selectors: [
      ["env", "prod", false],
      ["team", "ops", false],
    ],
    expected: true,
  },
  {
    name: "key-only does not wildcard values",
    logic: "any",
    tags: [["env", "prod"]],
    selectors: [["env", null, false]],
    expected: false,
  },
  {
    name: "key-only matches key-only",
    logic: "any",
    tags: [["env", null]],
    selectors: [["env", null, false]],
    expected: true,
  },
  {
    name: "any exclusion overrides global",
    logic: "any",
    global: true,
    tags: [["env", "prod"]],
    selectors: [["env", "prod", true]],
    expected: false,
  },
  {
    name: "all exclusions require full match",
    logic: "all",
    global: true,
    tags: [["env", "prod"]],
    selectors: [
      ["env", "prod", true],
      ["team", "ops", true],
    ],
    expected: true,
  },
  {
    name: "all exclusions match",
    logic: "all",
    global: true,
    tags: [
      ["env", "prod"],
      ["team", "ops"],
    ],
    selectors: [
      ["env", "prod", true],
      ["team", "ops", true],
    ],
    expected: false,
  },
  {
    name: "null disables tag matching",
    logic: null,
    tags: [["env", "prod"]],
    selectors: [["env", "prod", false]],
    expected: false,
  },
  {
    name: "inherited project tag",
    logic: "any",
    inherited: true,
    tags: [["env", "prod"]],
    selectors: [["env", "prod", false]],
    expected: true,
  },
  {
    name: "workspace override of inherited tag",
    logic: "any",
    inherited: true,
    override: true,
    tags: [["env", "prod"]],
    selectors: [["env", "prod", false]],
    expected: false,
  },
  {
    name: "explicit workspace survives no tag match",
    logic: "any",
    explicit: true,
    tags: [],
    selectors: [["env", "prod", false]],
    expected: true,
  },
  {
    name: "workspace exclusion overrides tag match",
    logic: "any",
    exclude: true,
    tags: [["env", "prod"]],
    selectors: [["env", "prod", false]],
    expected: false,
  },
  {
    name: "project exclusion overrides global scope",
    logic: "any",
    global: true,
    projectExclude: true,
    tags: [],
    selectors: [],
    expected: false,
  },
  {
    name: "project exclusion overrides tag inclusion",
    logic: "any",
    projectExclude: true,
    tags: [["env", "prod"]],
    selectors: [["env", "prod", false]],
    expected: false,
  },
  {
    name: "foreign organization cannot enter tag scope",
    logic: "any",
    foreign: true,
    tags: [["env", "prod"]],
    selectors: [["env", "prod", false]],
    expected: false,
  },
] as const;

for (const item of cases)
  test(`hosted policy scope: ${item.name}`, async () => {
    const id = crypto.randomUUID();
    const otherOrg = `${id}-other`;
    await db.insert(organizations).values([
      { id, name: id },
      { id: otherOrg, name: otherOrg },
    ]);
    try {
      await db.insert(projects).values({ id, orgId: id, name: id });
      await db.insert(workspaces).values({ id, orgId: id, name: id, projectId: id });
      await db.insert(runs).values({ id, workspaceId: id, status: "planned", logToken: id, createdAt: Date.now() });
      await db.insert(policySets).values({
        id,
        orgId: "foreign" in item ? otherOrg : id,
        name: id,
        kind: "sentinel",
        tagMatchLogic: item.logic,
        global: "global" in item,
      });
      await db.insert(policies).values({
        id,
        orgId: "foreign" in item ? otherOrg : id,
        policySetId: id,
        name: id,
        kind: "sentinel",
        enforcementLevel: "hard-mandatory",
      });
      for (const [key, value] of item.tags) {
        if ("inherited" in item)
          await db.insert(projectTags).values({ id: crypto.randomUUID(), projectId: id, key, value });
        else await db.insert(workspaceTags).values({ id: crypto.randomUUID(), workspaceId: id, key, value });
      }
      if ("override" in item)
        await db.insert(workspaceTags).values({ id: crypto.randomUUID(), workspaceId: id, key: "env", value: "dev" });
      for (const [key, value, isExclude] of item.selectors)
        await db
          .insert(policySetTagSelectors)
          .values({ id: crypto.randomUUID(), policySetId: id, key, value, isExclude });
      if ("explicit" in item) await db.insert(policySetWorkspaces).values({ id, policySetId: id, workspaceId: id });
      if ("exclude" in item) await db.insert(policySetExclusions).values({ id, policySetId: id, workspaceId: id });
      if ("projectExclude" in item)
        await db.insert(policySetProjectExclusions).values({ id, policySetId: id, projectId: id });
      // No plan artifact: every selected hard-mandatory policy must fail closed,
      // proving selection at the real execution boundary without an engine binary.
      const result = await runPolicyChecks(id, id, id);
      expect(result.hardFailed).toBe(item.expected);
      expect(result.proceed).toBe(!item.expected);
      const checks = (await db.query.policyChecks.findMany({ where: eq(policyChecks.runId, id) })).filter(
        (check) => !isPolicyEvaluationCheckpoint(check),
      );
      expect(checks.map((check) => check.policyId)).toEqual(item.expected ? [id] : []);
    } finally {
      // PostgreSQL can cascade through runs while SET NULL triggers from the
      // policy/policy-set branches still touch the same checks. Remove the
      // leaf rows first instead of relying on cross-branch cascade ordering.
      await db.delete(policyChecks).where(eq(policyChecks.runId, id));
      await db.delete(organizations).where(eq(organizations.id, id));
      await db.delete(organizations).where(eq(organizations.id, otherOrg));
    }
  });
