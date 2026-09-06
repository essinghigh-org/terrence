import { describe, expect, it } from "bun:test";
import {
  EXPLAIN_REDACTED_MARKER,
  redactKnownSecrets,
  sensitiveOutputSecrets,
} from "../../src/lib/explain-secrets";
import { explainTimeoutMs, EXPLAIN_TIMEOUT_MS } from "../../src/lib/run-explanations";

// Issue #687: value-based scrubbing for explainer prompts and completions.
describe("redactKnownSecrets", () => {
  it("replaces every occurrence longest-first without touching other text", () => {
    const secrets = ["alpha-secret-value", "secret-value"];
    const result = redactKnownSecrets("a alpha-secret-value and secret-value and alpha-secret-value end", secrets);
    expect(result.text).toBe(`a ${EXPLAIN_REDACTED_MARKER} and ${EXPLAIN_REDACTED_MARKER} and ${EXPLAIN_REDACTED_MARKER} end`);
    expect(result.hits).toBe(3);
  });

  it("ignores short values that would destroy ordinary prose", () => {
    const result = redactKnownSecrets("an api key", ["api", "key", "an"]);
    expect(result).toEqual({ text: "an api key", hits: 0 });
  });

  it("treats values as literals, never patterns", () => {
    const tricky = "a+b.*(c)";
    const result = redactKnownSecrets(`value ${tricky}12 and ${tricky} here`, [`${tricky}12`, tricky]);
    expect(result.text).toBe(`value ${EXPLAIN_REDACTED_MARKER} and ${EXPLAIN_REDACTED_MARKER} here`);
    expect(result.hits).toBe(2);
  });

  it("returns the input untouched when there is nothing to redact", () => {
    expect(redactKnownSecrets("plain text", [])).toEqual({ text: "plain text", hits: 0 });
    expect(redactKnownSecrets("plain text", ["elsewhere-value"])).toEqual({ text: "plain text", hits: 0 });
  });
});

describe("sensitiveOutputSecrets", () => {
  it("collects only sensitive scalar outputs", () => {
    const payload = JSON.stringify({
      outputs: {
        password: { value: "s3cr3t-p4ssw0rd", sensitive: true },
        public: { value: "hello", sensitive: false },
        implicit: { value: "world" },
      },
    });
    expect(sensitiveOutputSecrets(payload)).toEqual(["s3cr3t-p4ssw0rd"]);
  });

  it("stringifies sensitive composite outputs and rejects malformed payloads", () => {
    const payload = JSON.stringify({ outputs: { config: { value: { user: "u", pass: "p4ssw0rd!" }, sensitive: true } } });
    const secrets = sensitiveOutputSecrets(payload);
    expect(secrets).toHaveLength(1);
    expect(JSON.parse(secrets[0] ?? "{}")).toEqual({ user: "u", pass: "p4ssw0rd!" });
    expect(sensitiveOutputSecrets(null)).toEqual([]);
    expect(sensitiveOutputSecrets("not json")).toEqual([]);
    expect(sensitiveOutputSecrets(JSON.stringify({ outputs: [] }))).toEqual([]);
  });
});

describe("explainTimeoutMs", () => {
  it("defaults to the documented constant and accepts valid overrides", () => {
    delete process.env["TERRENCE_EXPLAIN_TIMEOUT_MS"];
    expect(explainTimeoutMs()).toBe(EXPLAIN_TIMEOUT_MS);
    process.env["TERRENCE_EXPLAIN_TIMEOUT_MS"] = "1500";
    expect(explainTimeoutMs()).toBe(1500);
    for (const bad of ["0", "-5", "1.5", "soon", "9007199254740993"]) {
      process.env["TERRENCE_EXPLAIN_TIMEOUT_MS"] = bad;
      expect(explainTimeoutMs()).toBe(EXPLAIN_TIMEOUT_MS);
    }
    delete process.env["TERRENCE_EXPLAIN_TIMEOUT_MS"];
  });
});
