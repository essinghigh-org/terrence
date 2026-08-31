import { describe, expect, it } from "bun:test";

// responseHeaders is module-private; exercise it through the exported
// delivery path is heavy (network). Instead re-implement the contract test
// against a Headers object via the same public shape the function produces:
// import the module and use the internal through a controlled fetch mock.
// Simpler and stable: verify redaction semantics directly by constructing
// Headers and asserting our documented rule set via the exported delivery
// record shape — but that requires network. So this file pins the redaction
// list behavior through the only seam available: a Headers instance passed
// through the same lowercase/redact logic duplicated here would be testing a
// copy. Instead we assert on real deliveries recorded by the API suite.
//
// The meaningful guarantee: sensitive header VALUES never reach the stored
// delivery record. That is covered end-to-end in
// tests/api/notification_delivery_responses.test.ts; this unit pins the
// redaction decision table itself by importing the private function through
// the module's test export.

import { redactedHeaderNamesForTests } from "../../src/lib/notifications";

describe("notification response header redaction (kanban 17)", () => {
  it("covers credential-bearing headers", (): void => {
    const names = redactedHeaderNamesForTests();
    for (const required of ["set-cookie", "authorization", "proxy-authorization", "www-authenticate", "cookie"]) {
      expect(names.has(required)).toBeTrue();
    }
  });

  it("covers topology-revealing headers", (): void => {
    const names = redactedHeaderNamesForTests();
    for (const required of ["server", "x-powered-by", "forwarded", "via"]) {
      expect(names.has(required)).toBeTrue();
    }
  });

  it("is lowercase-normalized", (): void => {
    const names = redactedHeaderNamesForTests();
    for (const name of names) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});
