import { describe, expect, it } from "bun:test";
import {
  appriseUrlFor,
  notificationTypeFor,
  ruleMatches,
  renderTemplate,
  type NotificationDestination,
  type NotificationRule,
} from "../../src/lib/notify";
import type { EventContext } from "../../src/lib/events";

function dest(overrides: Partial<NotificationDestination>): NotificationDestination {
  return {
    id: "d-1",
    orgId: "org-1",
    name: "test",
    type: "apprise-custom",
    config: { url: "json://localhost" },
    enabled: true,
    ...overrides,
  };
}

function rule(overrides: Partial<NotificationRule>): NotificationRule {
  return {
    id: "r-1",
    orgId: "org-1",
    name: "test rule",
    eventType: "workspace.apply.failed",
    workspaceTagFilters: [],
    destinationId: "d-1",
    templateId: null,
    enabled: true,
    ...overrides,
  };
}

function context(overrides: Partial<EventContext> = {}): EventContext {
  return {
    event: "workspace.apply.failed",
    workspace: {
      id: "ws-1",
      name: "prod",
      organizationName: "acme",
      tags: { environment: "production", team: "platform" },
    },
    ...overrides,
  };
}

const runContext = {
  id: "r-1",
  message: "boom",
  status: "errored",
  createdAt: 0,
  createdBy: null,
  commitSha: "abc",
  commitUrl: null,
  commitMessage: null,
  branch: null,
  url: "https://x/r",
};

describe("appriseUrlFor", () => {
  it("builds a slack URL from token + channel", () => {
    const d = dest({ type: "slack", config: { token: "xoxb-123", channel: "#alerts" } });
    expect(appriseUrlFor(d)).toBe("slack://xoxb-123/#alerts");
  });

  it("builds a discord URL from a webhook URL", () => {
    const d = dest({
      type: "discord",
      config: { webhookUrl: "https://discord.com/api/webhooks/111/abc" },
    });
    expect(appriseUrlFor(d)).toBe("discord://111/abc/");
  });

  it("builds a sendgrid URL from api key + from + to", () => {
    const d = dest({
      type: "sendgrid",
      config: { apiKey: "SG.abc", fromEmail: "noreply@acme.com", toEmail: "ops@acme.com" },
    });
    expect(appriseUrlFor(d)).toBe("sendgrid:///SG.abc:noreply@acme.com/ops@acme.com");
  });

  it("passes through apprise-custom urls verbatim", () => {
    const d = dest({ config: { url: "tgram://bottoken/chatid" } });
    expect(appriseUrlFor(d)).toBe("tgram://bottoken/chatid");
  });
});

describe("notificationTypeFor", () => {
  it("maps failed/drift events to failure", () => {
    expect(notificationTypeFor("workspace.plan.failed")).toBe("failure");
    expect(notificationTypeFor("workspace.apply.failed")).toBe("failure");
    expect(notificationTypeFor("workspace.drift.detected")).toBe("failure");
  });
  it("maps completed events to success", () => {
    expect(notificationTypeFor("workspace.plan.completed")).toBe("success");
    expect(notificationTypeFor("workspace.apply.completed")).toBe("success");
  });
  it("maps everything else to info", () => {
    expect(notificationTypeFor("workspace.run.started")).toBe("info");
    expect(notificationTypeFor("workspace.lock.created")).toBe("info");
  });
});

describe("ruleMatches", () => {
  it("matches an enabled rule with the same event and no filters", () => {
    expect(ruleMatches(rule(), context())).toBe(true);
  });

  it("does not match a different event", () => {
    const r = rule({ eventType: "workspace.plan.completed" });
    expect(ruleMatches(r, context())).toBe(false);
  });

  it("does not match a disabled rule", () => {
    const r = rule({ enabled: false });
    expect(ruleMatches(r, context())).toBe(false);
  });

  it("matches when all tag filters are satisfied", () => {
    const r = rule({
      workspaceTagFilters: [
        { key: "environment", value: "production" },
        { key: "team", value: "platform" },
      ],
    });
    expect(ruleMatches(r, context())).toBe(true);
  });

  it("does not match when a tag filter is missing or wrong", () => {
    const missing = rule({ workspaceTagFilters: [{ key: "environment", value: "staging" }] });
    expect(ruleMatches(missing, context())).toBe(false);
    const absent = rule({ workspaceTagFilters: [{ key: "region", value: "eu" }] });
    expect(ruleMatches(absent, context())).toBe(false);
  });

  it("renders through to the full pipeline shape", () => {
    // renderTemplate + ruleMatches compose for the classic example from the plan
    const r = rule({
      eventType: "workspace.apply.failed",
      workspaceTagFilters: [{ key: "environment", value: "production" }],
    });
    expect(ruleMatches(r, context())).toBe(true);
    const body = renderTemplate(
      "Run Failed\nWorkspace: {{workspace.name}}\nCommit: {{run.commitSha}}\nError: {{run.message}}",
      context({ run: runContext }),
    );
    expect(body).toContain("Workspace: prod");
    expect(body).toContain("Commit: abc");
    expect(body).toContain("Error: boom");
  });
});
