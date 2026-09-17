import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  githubAppCredentialStorage,
  githubAppManifestDocument,
  githubAppRegistrationUrl,
  githubAppSettingsUrl,
} from "../../src/lib/github-app-manifest";

const configuration = { privateKey: "private-key", webhookSecret: "webhook-secret" };

function decodeAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

test("manifest is JSON in a POST field, never an action query parameter", () => {
  const action = githubAppRegistrationUrl("https://github.com", "essinghigh-org");
  action.searchParams.set("state", "one-use-state");
  const manifest = {
    name: "Terrence",
    public: false,
    hook_attributes: { url: "https://terrence.test/api/webhooks/github" },
  };
  const { html } = githubAppManifestDocument(action.toString(), manifest);
  assert.match(html, /<form[^>]+method="post"/);
  const actionMatch = /action="([^"]+)"/.exec(html);
  assert.ok(actionMatch?.[1]);
  const submittedAction = new URL(decodeAttribute(actionMatch[1]));
  assert.equal(submittedAction.searchParams.get("state"), "one-use-state");
  assert.equal(submittedAction.searchParams.has("manifest"), false);
  const field = /name="manifest" value="([^"]*)"/.exec(html);
  assert.ok(field?.[1]);
  assert.deepEqual(JSON.parse(decodeAttribute(field[1])), manifest);
});

test("handoff pins form-action to one origin and authorizes only its nonce script", () => {
  const result = githubAppManifestDocument("https://github.example.test/settings/apps/new?state=abc", {});
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.headers["Referrer-Policy"], "no-referrer");
  const policy = result.headers["Content-Security-Policy"] ?? "";
  assert.match(policy, /form-action https:\/\/github\.example\.test(?:;|$)/);
  assert.doesNotMatch(policy, /unsafe-inline|\*/);
  const nonce = /nonce="([^"]+)"/.exec(result.html)?.[1];
  assert.ok(nonce);
  assert.ok(policy.includes(`script-src 'nonce-${nonce}'`));
  assert.match(result.html, /<noscript>/);
  assert.match(result.html, /<button type="submit">Continue to GitHub/);
  const second = githubAppManifestDocument("https://github.example.test/settings/apps/new?state=abc", {});
  assert.notEqual(second.headers["Content-Security-Policy"], policy);
});

test("manifest values cannot inject attributes or executable HTML", () => {
  const value = '\"><script>alert(1)</script><input name="x" value="&';
  const { html } = githubAppManifestDocument("https://github.com/settings/apps/new?state=abc", { name: value });
  assert.equal((html.match(/<script\b/g) ?? []).length, 1);
  assert.equal((html.match(/<input\b/g) ?? []).length, 1);
  const field = /name="manifest" value="([^"]*)"/.exec(html)?.[1];
  assert.ok(field);
  assert.deepEqual(JSON.parse(decodeAttribute(field)), { name: value });
});

test("registration explicitly distinguishes personal and organization ownership", () => {
  assert.equal(githubAppRegistrationUrl("https://github.com", "").pathname, "/settings/apps/new");
  assert.equal(
    githubAppRegistrationUrl("https://github.com", " essinghigh-org ").pathname,
    "/organizations/essinghigh-org/settings/apps/new",
  );
  assert.equal(
    githubAppRegistrationUrl("https://github.enterprise.test:8443", "team").origin,
    "https://github.enterprise.test:8443",
  );
});

test("organization input cannot change the registration origin or inject a path", () => {
  for (const owner of [
    "https://github.com/team",
    "../settings",
    "team/another",
    "x?state=bad",
    "-team",
    "team-",
    "a".repeat(40),
  ]) {
    assert.throws(() => githubAppRegistrationUrl("https://github.com", owner));
  }
});

test("manifest handoff rejects unsafe destinations and missing state", () => {
  for (const action of [
    "javascript:alert(1)",
    "data:text/html,test",
    "https://name:password@github.com/settings/apps/new?state=a",
    "https://github.com/settings/apps/new?state=a#fragment",
    "https://github.com/settings/apps/new?state=a&manifest=bad",
    "https://github.com/settings/apps/new",
    "https://github.com/login?state=a",
  ])
    assert.throws(() => githubAppManifestDocument(action, {}));
});

test("database credentials, not an import label, establish environment removal safety", () => {
  assert.deepEqual(githubAppCredentialStorage({ status: "active", configuration }, true), {
    "credential-storage": "database",
    "environment-removable": true,
  });
  assert.deepEqual(githubAppCredentialStorage(null, true), {
    "credential-storage": "environment",
    "environment-removable": false,
  });
  assert.deepEqual(githubAppCredentialStorage(null, false), {
    "credential-storage": "none",
    "environment-removable": false,
  });
});

test("invalid, disconnected and undecryptable records never advise removing credentials", () => {
  for (const record of [
    { status: "invalid", configuration },
    { status: "disconnected", configuration: null },
    { status: "active", configuration: null },
    { status: "active", configuration: { privateKey: "", webhookSecret: "secret" } },
    { status: "active", configuration: { privateKey: "key", webhookSecret: null } },
    { status: "active", configuration: { privateKey: "key", webhookSecret: "  " } },
  ])
    assert.equal(githubAppCredentialStorage(record, true)["environment-removable"], false);
});

test("disconnect tombstone does not imply environment fallback", () => {
  assert.equal(
    githubAppCredentialStorage({ status: "disconnected", configuration: null }, true)["credential-storage"],
    "none",
  );
});

test("credential storage metadata never serializes any secret", () => {
  const value = JSON.stringify(githubAppCredentialStorage({ status: "active", configuration }, true));
  assert.doesNotMatch(value, /private-key|webhook-secret/);
});

test("settings links use the validated account type", () => {
  assert.equal(
    githubAppSettingsUrl("https://github.com", "terrence", "essinghigh-org", "Organization"),
    "https://github.com/organizations/essinghigh-org/settings/apps/terrence",
  );
  assert.equal(
    githubAppSettingsUrl("https://github.com", "terrence", "user", "User"),
    "https://github.com/settings/apps/terrence",
  );
  assert.equal(
    githubAppSettingsUrl("https://github.com", "terrence", "unknown", undefined),
    "https://github.com/apps/terrence",
  );
});
