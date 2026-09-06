import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseTerraformVariablesJson,
  parseTerraformVariablesWithDiagnostics,
  TERRAFORM_VARIABLE_PARSER_LIMITS,
  TerraformVariableParseError,
} from "../../src/lib/terraform-variables";

type ParserSeed = Readonly<{ name: string; source: string }>;

const parserSeeds = JSON.parse(
  readFileSync(join(import.meta.dir, "../fixtures/property-model/parser-seeds.json"), "utf8"),
) as ParserSeed[];

function rand32(seed: number): () => number {
  let value = seed >>> 0;
  return (): number => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function propertyCases(): number {
  const requested = Number.parseInt(process.env["TERRENCE_PROPERTY_CASES"] ?? "256", 10);
  return Number.isSafeInteger(requested) && requested > 0 && requested <= 10_000 ? requested : 256;
}

function typedParserFailure(error: unknown): boolean {
  return error instanceof TerraformVariableParseError;
}

describe("bounded parser properties", () => {
  it("keeps arbitrary HCL and Markdown truncations typed and bounded", () => {
    const cases = propertyCases();
    const started = performance.now();
    for (const [seedIndex, seed] of parserSeeds.entries()) {
      const random = rand32(seedIndex + 0x753);
      for (let caseIndex = 0; caseIndex < cases; caseIndex += 1) {
        const end = Math.floor(random() * (seed.source.length + 1));
        const prefix = seed.source.slice(0, end);
        const hclSource = seed.name === "json-prefix" ? `${prefix}# truncated` : prefix;
        try {
          if (seed.name === "json-prefix") {
            expect(parseTerraformVariablesJson(prefix).length).toBeLessThanOrEqual(TERRAFORM_VARIABLE_PARSER_LIMITS.maxVariables);
          } else {
            const parsed = parseTerraformVariablesWithDiagnostics(hclSource);
            expect(parsed.variables.length).toBeLessThanOrEqual(TERRAFORM_VARIABLE_PARSER_LIMITS.maxVariables);
            expect(parsed.skipped.length).toBeLessThanOrEqual(TERRAFORM_VARIABLE_PARSER_LIMITS.maxDiagnostics);
          }
        } catch (error: unknown) {
          expect(typedParserFailure(error), `${seed.name} case ${caseIndex}: ${String(error)}`).toBe(true);
          if (prefix.length > 0) expect(String(error)).not.toContain(prefix.slice(0, 80));
        }

      }
    }
    // A pathological prefix must remain a bounded operation.  This is a
    // generous aggregate budget so slow hosted runners fail as real failures,
    // rather than being retried as flaky property tests.
    expect(performance.now() - started).toBeLessThan(15_000);
  });

  it("caps diagnostics as well as successful metadata", () => {
    const invalidBlocks = Array.from(
      { length: TERRAFORM_VARIABLE_PARSER_LIMITS.maxDiagnostics + 1 },
      (_, index) => `variable "\\uZZZZ${index}" {}`,
    ).join("\n");
    expect(() => parseTerraformVariablesWithDiagnostics(invalidBlocks)).toThrow(TerraformVariableParseError);
    try {
      parseTerraformVariablesWithDiagnostics(invalidBlocks);
    } catch (error: unknown) {
      expect((error as TerraformVariableParseError).code).toBe("output-too-large");
    }
  });
});
