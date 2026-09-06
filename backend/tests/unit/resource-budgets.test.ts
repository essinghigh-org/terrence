import { describe, expect, test } from "bun:test";
import {
  assessResourceBudget,
  defaultResourceBudgetConfig,
  parseResourceBudgetConfig,
  resourceBudgetSnapshot,
  selectResourceBudgetJob,
  type ResourceBudgetJob,
  type ResourceBudgetState,
} from "../../src/lib/resource-budgets";

function job(
  id: string,
  organizationId: string | null,
  jobClass: ResourceBudgetJob["jobClass"],
  createdAt: number,
  estimatedBytes = 0,
): ResourceBudgetJob {
  return { id, organizationId, jobClass, estimatedBytes, runAfter: 0, createdAt };
}

function state(queued: readonly ResourceBudgetJob[], running: readonly ResourceBudgetJob[] = []): ResourceBudgetState {
  return { queued, running };
}

describe("resource budget policy", () => {
  test("uses safe defaults and supports exact organization overrides", () => {
    const config = parseResourceBudgetConfig({
      TERRENCE_RESOURCE_BUDGETS_JSON: JSON.stringify({
        global: { concurrency: 8, queue: 80, artifactBytes: 1_000_000, reservedCriticalSlots: 2 },
        organization: { concurrency: 3, queue: 30 },
        classes: { explanation: { concurrency: 1, queue: 5 } },
        organizations: { "org-a": { concurrency: 6, artifactBytes: 2_000_000 } },
      }),
    });
    expect(config.global.concurrency).toBe(8);
    expect(config.organization.concurrency).toBe(3);
    expect(config.classes.explanation.queue).toBe(5);
    expect(config.organizationOverrides["org-a"]?.concurrency).toBe(6);
    expect(config.organizationOverrides["org-a"]?.artifactBytes).toBe(2_000_000);
    expect(defaultResourceBudgetConfig().global.concurrency).toBe(5);
  });

  test("rejects malformed and unsafe operator policy values", () => {
    expect(() => parseResourceBudgetConfig({ TERRENCE_RESOURCE_BUDGETS_JSON: "{" })).toThrow();
    expect(() => parseResourceBudgetConfig({
      TERRENCE_RESOURCE_BUDGETS_JSON: JSON.stringify({ global: { reservedCriticalSlots: 9, concurrency: 2 } }),
    })).toThrow();
    expect(() => parseResourceBudgetConfig({
      TERRENCE_RESOURCE_BUDGETS_JSON: JSON.stringify({ organizations: { "bad id": { queue: 2 } } }),
    })).toThrow();
    expect(() => parseResourceBudgetConfig({
      TERRENCE_RESOURCE_BUDGETS_JSON: JSON.stringify({ classes: { plan: { artifactBytes: 2 } } }),
    })).toThrow();
  });

  test("returns retry guidance while allowing a fair queue", () => {
    const config = parseResourceBudgetConfig({
      TERRENCE_RESOURCE_BUDGETS_JSON: JSON.stringify({ global: { concurrency: 2, queue: 2, reservedCriticalSlots: 0 } }),
    });
    const admission = assessResourceBudget(config, state([job("q1", "org-a", "plan", 1)], [job("r1", "org-a", "plan", 0), job("r2", "org-b", "plan", 0)]), job("q2", "org-b", "plan", 2));
    expect(admission.accepted).toBe(true);
    expect(admission.queuePosition).toBe(2);
    expect(admission.retryAfterMs).toBe(1_000);
    const classWaitConfig = parseResourceBudgetConfig({
      TERRENCE_RESOURCE_BUDGETS_JSON: JSON.stringify({ global: { concurrency: 4, reservedCriticalSlots: 0 }, classes: { plan: { concurrency: 1 } } }),
    });
    const classWait = assessResourceBudget(classWaitConfig, state([], [job("r1", "org-c", "plan", 0)]), job("q3", "org-b", "plan", 3));
    expect(classWait.accepted).toBe(true);
    expect(classWait.retryAfterMs).toBe(1_000);
    const rejected = assessResourceBudget(config, state([job("q1", "org-a", "plan", 1), job("q2", "org-b", "plan", 2)]), job("q3", "org-c", "plan", 3));
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toBe("global-queue-limit");
    expect(rejected.retryAfterMs).toBe(1_000);
  });

  test("bounds memory-intensive work by global and organization bytes", () => {
    const config = parseResourceBudgetConfig({
      TERRENCE_RESOURCE_BUDGETS_JSON: JSON.stringify({
        global: { artifactBytes: 100 },
        organization: { artifactBytes: 80 },
      }),
    });
    const tooLarge = assessResourceBudget(config, state([]), job("large", "org-a", "export", 1, 81));
    expect(tooLarge.accepted).toBe(false);
    expect(tooLarge.reason).toBe("artifact-bytes-limit");
    const waiting = assessResourceBudget(config, state([job("queued", "org-b", "export", 1, 70)]), job("next", "org-a", "export", 2, 40));
    expect(waiting.accepted).toBe(true);
    expect(waiting.retryAfterMs).toBe(1_000);
  });

  test("keeps protected capacity available for recovery work", () => {
    const config = parseResourceBudgetConfig({
      TERRENCE_RESOURCE_BUDGETS_JSON: JSON.stringify({ global: { concurrency: 2, reservedCriticalSlots: 1 } }),
    });
    const queued = [job("ordinary", "org-a", "explanation", 1), job("recover", "org-b", "critical", 2)];
    const selected = selectResourceBudgetJob(config, state(queued, [job("running", "org-a", "plan", 0)]));
    expect(selected?.id).toBe("recover");
  });

  test("shares ordinary capacity between organizations deterministically", () => {
    const config = parseResourceBudgetConfig({
      TERRENCE_RESOURCE_BUDGETS_JSON: JSON.stringify({ global: { concurrency: 2, reservedCriticalSlots: 0 } }),
    });
    const queued = [job("a-old", "org-a", "plan", 1), job("a-next", "org-a", "plan", 2), job("b-old", "org-b", "plan", 3)];
    const first = selectResourceBudgetJob(config, state(queued));
    expect(first?.id).toBe("a-old");
    const second = selectResourceBudgetJob(config, state(queued.filter((item): boolean => item.id !== first?.id), [first!]));
    expect(second?.id).toBe("b-old");
  });

  test("does not exceed global concurrency and shares ordinary classes", () => {
    const config = parseResourceBudgetConfig({
      TERRENCE_RESOURCE_BUDGETS_JSON: JSON.stringify({ global: { concurrency: 2, reservedCriticalSlots: 1 } }),
    });
    expect(selectResourceBudgetJob(config, state([job("waiting", "org-a", "critical", 1)], [
      job("critical-running", "org-a", "critical", 0),
      job("ordinary-running", "org-b", "run", 0),
    ]))).toBeUndefined();

    const fairConfig = parseResourceBudgetConfig({
      TERRENCE_RESOURCE_BUDGETS_JSON: JSON.stringify({ global: { concurrency: 2, reservedCriticalSlots: 0 } }),
    });
    const ordinary = [job("run", "org-a", "run", 1), job("explanation", "org-b", "explanation", 2)];
    expect(selectResourceBudgetJob(fairConfig, state(ordinary, [job("run-running", "org-c", "run", 0)]))?.id).toBe("explanation");
  });

  test("snapshots aggregate usage without organization identities", () => {
    const config = defaultResourceBudgetConfig();
    const snapshot = resourceBudgetSnapshot(config, state([
      job("q1", "secret-org-a", "export", 1, 10),
    ], [
      job("r1", "secret-org-b", "run", 1, 20),
    ]));
    expect(snapshot.queued).toBe(1);
    expect(snapshot.runningBytes).toBe(20);
    expect(snapshot.queuedByClass.export).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain("secret-org");
  });
});
