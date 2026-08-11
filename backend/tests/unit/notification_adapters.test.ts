import { describe, expect, it } from "bun:test";
import { renderPayloadForDestination } from "../../src/lib/notifications";

// Only destinationType and token are consulted by renderPayloadForDestination;
// the remaining fields are type-fixed placeholders. NotificationConfiguration
// is intentionally not exported, so we derive it from the render function's
// parameter slot.
type Config = Parameters<typeof renderPayloadForDestination>[0];

function config(destinationType: Config["destinationType"]): Config {
  return {
    id: "cfg",
    workspaceId: "ws",
    name: "n",
    destinationType,
    url: "https://example.invalid/hook",
    triggers: [],
    enabled: true,
    token: null,
  } as unknown as Config;
}

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
  notifications: [{ message: "Run Completed", trigger: "run:completed", run_status: "completed", run_updated_at: "2026-01-01T00:00:01.000Z", run_updated_by: "henry" }],
};

describe("Notification rich destination adapters (kanban 7.11)", () => {
  it("generic destinations receive the raw structured JSON payload unchanged", () => {
    const render = renderPayloadForDestination(config("generic"), runPayload);
    expect(render.contentType).toBe("application/json");
    expect(JSON.parse(render.body)).toEqual(runPayload);
  });

  it("slack destinations render an incoming-webhook blocks payload", () => {
    const render = renderPayloadForDestination(config("slack"), runPayload);
    expect(render.contentType).toBe("application/json");
    const slack = JSON.parse(render.body) as {
      text: string;
      blocks: Array<Record<string, unknown>>;
    };
    expect(slack.text).toBe("Run Completed");
    // A header block plus an actions block with the run's link button.
    expect(slack.blocks[0]).toMatchObject({ type: "header" });
    const button = slack.blocks.find((block) => block.type === "actions") as
      | { elements?: Array<Record<string, unknown>> }
      | undefined;
    expect(button?.elements?.[0]).toMatchObject({ type: "button", url: runPayload.run_url as string });
    // Structured fields include workspace + org + actor.
    const body = render.body;
    expect(body).toContain("*Workspace:*");
    expect(body).toContain("prod");
    expect(body).toContain("*Organization:*");
    expect(body).toContain("acme");
    expect(body).toContain("*Triggered by:*");
    expect(body).toContain("henry");
  });

  it("microsoft-teams destinations render a MessageCard with facts and an action", () => {
    const render = renderPayloadForDestination(config("microsoft-teams"), runPayload);
    const card = JSON.parse(render.body) as {
      "@type": string;
      title: string;
      sections?: Array<{ facts?: Array<{ name: string; value: string }> }>;
      potentialAction?: Array<{ name: string; targets: Array<{ uri: string }> }>;
    };
    expect(card["@type"]).toBe("MessageCard");
    expect(card.title).toBe("Run Completed");
    expect(card.sections?.[0]?.facts).toContainEqual({ name: "Workspace", value: "prod" });
    expect(card.potentialAction?.[0]).toMatchObject({ name: "Open run" });
    expect(card.potentialAction?.[0]?.targets?.[0]?.uri).toBe(runPayload.run_url as string);
  });

  it("assessment notifications surface drift/check context in both adapters", () => {
    const assessmentPayload: Record<string, unknown> = {
      payload_version: "2",
      trigger: "assessment:drifted",
      message: "Drift Detected",
      details: {
        new_assessment_result: { id: "ar-1", url: "https://terrence.local/api/v2/assessment-results/ar-1", resources_drifted: 3, checks_failed: 1 },
        workspace_id: "ws-1",
        workspace_name: "prod",
        organization_name: "acme",
      },
    };

    const slack = JSON.parse(renderPayloadForDestination(config("slack"), assessmentPayload).body) as { text: string; blocks: Array<Record<string, unknown>> };
    expect(slack.text).toBe("Drift Detected");
    const body = renderPayloadForDestination(config("slack"), assessmentPayload).body;
    expect(body).toContain("3");
    expect(body).toContain("Resources drifted");

    const teams = JSON.parse(renderPayloadForDestination(config("microsoft-teams"), assessmentPayload).body) as {
      title: string;
      sections?: Array<{ facts?: Array<{ name: string; value: string }> }>;
    };
    expect(teams.title).toBe("Drift Detected");
    expect(teams.sections?.[0]?.facts).toContainEqual({ name: "Resources drifted", value: "3" });
    expect(teams.sections?.[0]?.facts).toContainEqual({ name: "Failed checks", value: "1" });
  });
});