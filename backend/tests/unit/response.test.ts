import { describe, expect, it } from "bun:test";
import { applyResource, planResource, userResource } from "../../src/lib/response";

describe("userResource", () => {
  it("serializes a full user", () => {
    const result = userResource({
      id: "user-abc",
      username: "alice",
      email: "alice@example.com",
      isSiteAdmin: true,
    });
    expect(result.id).toBe("user-abc");
    expect(result.type).toBe("users");
    expect(result.attributes.username).toBe("alice");
    expect(result.attributes.email).toBe("alice@example.com");
    expect(result.attributes["is-site-admin"]).toBeTrue();
    expect(result.attributes["must-change-password"]).toBeFalse();
    expect(result.attributes["auth-method"]).toBe("local");
    expect(result.attributes["v2-only"]).toBeFalse();
    expect(result.attributes["is-service-account"]).toBeFalse();
  });

  it("defaults isSiteAdmin to false when not set", () => {
    const result = userResource({ id: "user-1", username: "bob" });
    expect(result.attributes["is-site-admin"]).toBeFalse();
  });

  it("defaults mustChangePassword to false when not set", () => {
    const result = userResource({ id: "user-1", username: "bob" });
    expect(result.attributes["must-change-password"]).toBeFalse();
  });

  it("sets mustChangePassword when truthy", () => {
    const result = userResource({ id: "user-1", username: "bob", mustChangePassword: true });
    expect(result.attributes["must-change-password"]).toBeTrue();
  });

  it("sets email to null when missing", () => {
    const result = userResource({ id: "user-1", username: "charlie" });
    expect(result.attributes.email).toBeNull();
  });

  it("marks as service account when authenticatedResource is not users", () => {
    const result = userResource(
      { id: "agent-1", username: "agent" },
      { id: "agent-1", type: "agent-pools" },
    );
    expect(result.attributes["is-service-account"]).toBeTrue();
    expect(result.relationships["authenticated-resource"].data).toEqual({
      id: "agent-1",
      type: "agent-pools",
    });
  });

  it("generates avatar URL from email hash", () => {
    const result = userResource({ id: "u-1", username: "x", email: "test@test.com" });
    const avatarUrl = result.attributes["avatar-url"];
    expect(avatarUrl).toInclude("gravatar.com/avatar/");
  });

  it("falls back to default avatar when email is empty", () => {
    const result = userResource({ id: "user-fallback", username: "y", email: "" });
    const avatarUrl = result.attributes["avatar-url"];
    expect(avatarUrl).toInclude("gravatar.com/avatar/00000000000000000000000000000000");
    expect(avatarUrl).toInclude("d=mp&s=80&f=y");
  });

  it("sets permissions for user type", () => {
    const result = userResource({ id: "u-1", username: "alice", email: null });
    const perms = result.attributes.permissions as Record<string, boolean>;
    expect(perms["can-create-organizations"]).toBeTrue();
    expect(perms["can-change-email"]).toBeTrue();
    expect(perms["can-change-username"]).toBeTrue();
  });

  it("restricts permissions for non-user types", () => {
    const result = userResource(
      { id: "api-1", username: "api-token" },
      { id: "api-1", type: "api-tokens" },
    );
    const perms = result.attributes.permissions as Record<string, boolean>;
    expect(perms["can-create-organizations"]).toBeFalse();
    expect(perms["can-change-email"]).toBeFalse();
    expect(perms["can-change-username"]).toBeFalse();
  });

  it("includes self link", () => {
    const result = userResource({ id: "user-link", username: "link" });
    expect(result.links).toEqual({ self: "/api/v2/users/user-link" });
  });

  it("includes authentication-tokens relationship link", () => {
    const result = userResource({ id: "user-rel", username: "rel" });
    const rel = result.relationships["authentication-tokens"] as Record<string, unknown>;
    expect((rel.links as Record<string, string>).related).toBe(
      "/api/v2/users/user-rel/authentication-tokens",
    );
  });
});

describe("run phase resources", () => {
  it("keeps resource counts unknown until a phase reports them", () => {
    const request = { url: "http://terrence.test/api/v2/runs/run-pending/plan" };
    const pending = {
      id: "run-pending",
      status: "pending",
      planResourceAdditions: null,
      planResourceChanges: null,
      planResourceDestructions: null,
      applyResourceAdditions: null,
      applyResourceChanges: null,
      applyResourceDestructions: null,
    } as unknown as Parameters<typeof planResource>[0];
    const finished = {
      ...pending,
      id: "run-finished",
      status: "applied",
      planResourceAdditions: 0,
      planResourceChanges: 0,
      planResourceDestructions: 0,
      applyResourceAdditions: 0,
      applyResourceChanges: 0,
      applyResourceDestructions: 0,
    } as unknown as Parameters<typeof planResource>[0];

    const pendingPlan = planResource(pending, request).attributes as Record<string, unknown>;
    const pendingApply = applyResource(pending, request).attributes as Record<string, unknown>;
    const finishedPlan = planResource(finished, request).attributes as Record<string, unknown>;
    const finishedApply = applyResource(finished, request).attributes as Record<string, unknown>;
    expect(pendingPlan["resource-additions"]).toBeNull();
    expect(pendingApply["resource-additions"]).toBeNull();
    expect(finishedPlan["resource-additions"]).toBe(0);
    expect(finishedApply["resource-additions"]).toBe(0);
  });

  it("attributes terminal failures to the phase that actually started", () => {
    const request = { url: "http://terrence.test/api/v2/runs/run-phase/plan" };
    const failedPlan = {
      id: "run-plan-failed",
      status: "errored",
      statusTimestamps: {
        "planning-at": "2026-07-29T09:00:00.000Z",
        "errored-at": "2026-07-29T09:00:01.000Z",
      },
    } as unknown as Parameters<typeof planResource>[0];
    const failedApply = {
      id: "run-apply-failed",
      status: "errored",
      statusTimestamps: {
        "planning-at": "2026-07-29T09:00:00.000Z",
        "planned-at": "2026-07-29T09:00:01.000Z",
        "applying-at": "2026-07-29T09:00:02.000Z",
        "errored-at": "2026-07-29T09:00:03.000Z",
      },
    } as unknown as Parameters<typeof planResource>[0];

    expect((planResource(failedPlan, request).attributes as Record<string, unknown>).status).toBe("errored");
    expect((applyResource(failedPlan, request).attributes as Record<string, unknown>).status).toBe("pending");
    expect((planResource(failedApply, request).attributes as Record<string, unknown>).status).toBe("finished");
    expect((applyResource(failedApply, request).attributes as Record<string, unknown>).status).toBe("errored");
  });
});
