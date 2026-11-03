import { expect, test } from "bun:test";
import { providerCompareUrl } from "../../scripts/lib/provider-compare-url";

test("provider comparison uses canonical release tags on the fixed upstream endpoint", () => {
  expect(providerCompareUrl("0.82.0", "0.83.0")).toBe(
    "https://api.github.com/repos/hashicorp/terraform-provider-tfe/compare/v0.82.0...v0.83.0",
  );
  expect(providerCompareUrl("1.2.3", "10.20.30")).toEndWith("/compare/v1.2.3...v10.20.30");
});

test("provider comparison rejects non-release data in either input", () => {
  for (const value of [
    "https://attacker.example/",
    "//attacker.example/",
    "../0.83.0",
    "0.83.0?secret=contents",
    "0.83.0#fragment",
    "0.83.0/extra",
    "0.83.0\n",
    "0.83.0-rc1",
    "v0.83.0",
    "00.83.0",
    "0.83",
    "0.83.0.1",
    "-1.83.0",
    "9007199254740992.0.0",
    "",
  ]) {
    expect(() => providerCompareUrl(value, "0.83.0")).toThrow("Invalid provider comparison version");
    expect(() => providerCompareUrl("0.82.0", value)).toThrow("Invalid provider comparison version");
  }
});
