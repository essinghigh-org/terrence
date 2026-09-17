import { test } from "bun:test";
import assert from "node:assert/strict";
import { githubAppAuthorizationUrl, githubAppSourceLabel, githubAppStorageNotice } from "../src/lib/github-app-admin";

const payload = (url: string): unknown => ({ data: { attributes: { "authorization-url": url } } });

test("friendly labels distinguish an import from live environment fallback", () => {
  assert.equal(githubAppSourceLabel("legacy_environment_import"), "Imported from environment");
  assert.equal(githubAppSourceLabel("environment"), "Using environment variables");
  assert.equal(githubAppSourceLabel("manifest"), "Created with GitHub");
  assert.equal(githubAppSourceLabel("manual"), "Added manually");
});

test("an import label or active status alone never permits environment removal", () => {
  const result = githubAppStorageNotice({ status: "active", source: "legacy_environment_import" });
  assert.equal(result.canRemoveEnvironment, false);
  assert.match(result.description, /Do not remove/);
});

test("database storage must be active and explicitly complete", () => {
  assert.equal(
    githubAppStorageNotice({ status: "active", "credential-storage": "database", "environment-removable": true })
      .canRemoveEnvironment,
    true,
  );
  for (const status of ["invalid", "disconnected", "unconfigured"]) {
    assert.equal(
      githubAppStorageNotice({ status, "credential-storage": "database", "environment-removable": true })
        .canRemoveEnvironment,
      false,
    );
  }
  assert.equal(
    githubAppStorageNotice({ status: "active", "credential-storage": "database" }).canRemoveEnvironment,
    false,
  );
});

test("environment-only operation clearly requires keeping deployment credentials", () => {
  const result = githubAppStorageNotice({ status: "active", "credential-storage": "environment" });
  assert.equal(result.canRemoveEnvironment, false);
  assert.match(result.title, /Still using/);
  assert.match(result.description, /Keep/);
});

test("creation accepts only the same-origin handoff with state", () => {
  const url = "https://terrence.test/api/v2/admin/github-app/manifest/redirect?state=abc";
  assert.equal(githubAppAuthorizationUrl(payload(url), "https://terrence.test", "manifest"), url);
  for (const value of [
    "https://github.com/settings/apps/new?state=abc&manifest=bad",
    "https://terrence.test.evil.test/api/v2/admin/github-app/manifest/redirect?state=abc",
    "https://terrence.test/api/v2/admin/github-app/manifest/redirect",
    "https://terrence.test/login?state=abc",
    "https://user:password@terrence.test/api/v2/admin/github-app/manifest/redirect?state=abc",
    "javascript:alert(1)",
  ])
    assert.throws(() => githubAppAuthorizationUrl(payload(value), "https://terrence.test", "manifest"));
});

test("installation resume is still a GET navigation to the configured GitHub host", () => {
  for (const host of ["github.com", "github.enterprise.test"]) {
    const url = `https://${host}/apps/terrence/installations/new?state=abc`;
    assert.equal(githubAppAuthorizationUrl(payload(url), "https://terrence.test", "installation"), url);
  }
  assert.throws(() =>
    githubAppAuthorizationUrl(
      payload("https://github.com/settings/apps/new?state=abc"),
      "https://terrence.test",
      "installation",
    ),
  );
});

test("malformed API responses fail with a setup error", () => {
  for (const value of [null, {}, [], { data: null }, { data: { attributes: {} } }]) {
    assert.throws(() => githubAppAuthorizationUrl(value, "https://terrence.test", "manifest"), /setup URL/);
  }
});
