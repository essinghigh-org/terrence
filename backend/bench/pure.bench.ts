/**
 * Pure-function benchmarks.
 * Run: bun run bench/pure.bench.ts [--json bench/baseline-pure.json]
 */
import { suite, report } from "./harness";
import { applySecurityHeaders, buildContentSecurityPolicy, staticCacheControl, staticMimeFor } from "../src/lib/security-headers";
import { privateHostReason, validateExternalUrlResolved } from "../src/lib/url-safety";
import { planJsonResourceCounts, type PlanJson } from "../src/lib/plan-json";
import { renderPayloadForDestination } from "../src/lib/notifications";
import { pageRequest, pagination, signedApiURL } from "../src/lib/utils";

// --- security headers (runs once per HTTP response) ---
await suite("security-headers", {
  "applySecurityHeaders (fresh target)": () => {
    applySecurityHeaders({});
  },
  "buildContentSecurityPolicy": () => {
    buildContentSecurityPolicy();
  },
  "staticCacheControl (asset path)": () => {
    staticCacheControl("/assets/server-B90Icef7.js");
  },
  "staticMimeFor (asset path)": () => {
    staticMimeFor("/assets/server-B90Icef7.js");
  },
});

// --- url-safety (webhook + notification path) ---
const HOSTS = [
  "example.com", "api.github.com", "terraform.essinghigh.dev", "localhost", "127.0.0.1",
  "169.254.169.254", "10.0.0.1", "192.168.1.69", "172.16.4.4", "100.64.0.1",
  "224.0.0.1", "240.0.0.1", "0.0.0.0", "2130706433", "localhost.nip.io",
  "169.254.169.254.nip.io", "0x7f000001.nip.io", "::1", "[::1]",
  "0:0:0:0:0:ffff:127.0.0.1", "2001:4860:4860::8888", "sub.domain.co.uk",
  "my-workspace-123.s3.amazonaws.com", "8.8.8.8", "1.1.1.1",
];
await suite("url-safety", {
  "privateHostReason over 24-host corpus": () => {
    for (const host of HOSTS) privateHostReason(host);
  },
  "validateExternalUrlResolved (public stub resolver)": async () => {
    for (const url of ["https://example.com/hook", "https://api.github.com/repos/x", "https://terraform.essinghigh.dev/api"]) {
      await validateExternalUrlResolved(url, false, async (): Promise<string[]> => ["93.184.216.34"]);
    }
  },
});

// --- plan JSON resource counts (runs once per plan completion) ---
function syntheticPlan(resources: number): PlanJson {
  const resourceChanges: Array<Record<string, unknown>> = [];
  for (let i = 0; i < resources; i += 1) {
    resourceChanges.push({
      mode: i % 7 === 0 ? "data" : "managed",
      type: "aws_instance",
      name: `instance_${i}`,
      change: {
        actions: i % 3 === 0 ? ["create"] : i % 3 === 1 ? ["update"] : ["delete"],
        importing: i % 11 === 0 ? { id: "i-123" } : undefined,
      },
    });
  }
  return { resource_changes: resourceChanges } as unknown as PlanJson;
}
const plan1000 = syntheticPlan(1000);
const plan100 = syntheticPlan(100);
await suite("plan-json", {
  "planJsonResourceCounts (1000 resources)": () => {
    planJsonResourceCounts(plan1000);
  },
  "planJsonResourceCounts (100 resources)": () => {
    planJsonResourceCounts(plan100);
  },
});

// --- notification rendering ---
const runPayload: Record<string, unknown> = {
  payload_version: 1,
  notification_configuration_id: "cfg",
  run_url: "https://terrence.local/app/acme/workspaces/prod/runs/run-1",
  run_id: "run-1",
  run_message: "apply changed 2 resources",
  run_created_at: "2026-01-01T00:00:00.000Z",
  run_created_by: "henry",
  workspace_id: "ws-1",
  workspace_name: "prod",
  organization_name: "acme",
  notifications: [{ message: "Run Completed", trigger: "run:completed", run_status: "completed" }],
};
await suite("notifications", {
  "renderPayloadForDestination (generic)": () => {
    renderPayloadForDestination({ id: "cfg", workspaceId: "ws", name: "n", destinationType: "generic", url: "https://x.invalid", triggers: [], enabled: true, token: null } as never, runPayload);
  },
});

// --- run resource serialization (every run list/read pays this) ---
import { runResource } from "../src/lib/response";
function syntheticRun(id: string): Record<string, unknown> {
  return {
    id,
    workspaceId: "ws-1",
    status: "planned",
    statusTimestamps: { "planned-at": "2026-01-01T00:00:00.000Z", "plan-queued-at": "2026-01-01T00:00:01.000Z" },
    createdAt: Date.now() - 60_000,
    autoApply: false,
    planOnly: false,
    refresh: true,
    refreshOnly: false,
    isDestroy: false,
    savePlan: false,
    allowEmptyApply: false,
    allowConfigGeneration: false,
    debuggingMode: false,
    message: "apply via webhook",
    terraformVersion: "1.8.0",
    targetAddrs: null,
    replaceAddrs: null,
    variables: [],
    logToken: "token",
  } as Record<string, unknown>;
}
const runList100 = Array.from({ length: 100 }, (_, i) => syntheticRun(`run-${i}`));
await suite("run-resource", {
  "single runResource": () => {
    runResource(runList100[0] as never, true, false, undefined, null);
  },
  "100-run list serialization": () => {
    for (const run of runList100) runResource(run as never, true, false, undefined, null);
  },
});

// --- request helpers ---
const fakeRequest = {
  url: "https://terrence.local/api/v2/organizations/acme/workspaces?page%5Bnumber%5D=2&page%5Bsize%5D=25",
} as never;
await suite("request-helpers", {
  "pageRequest": () => {
    pageRequest(fakeRequest);
  },
  "pagination (25/page, 1000 total)": () => {
    pagination(fakeRequest, 2, 25, 1000);
  },
  "signedApiURL (HMAC)": () => {
    signedApiURL(fakeRequest, "/api/v2/runs/run-1/events", "GET", 300);
  },
});

report();
