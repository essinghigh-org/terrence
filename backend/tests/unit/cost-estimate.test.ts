import { describe, expect, it } from "bun:test";
import { emptyCostEstimate, parseInfracostOutput } from "../../src/lib/cost-estimate";

describe("emptyCostEstimate", () => {
  it("returns a finished estimate with all zero values", () => {
    const result = emptyCostEstimate("finished", {
      "queued-at": "2026-01-01T00:00:00Z",
      "pending-at": "2026-01-01T00:01:00Z",
      "finished-at": "2026-01-01T00:02:00Z",
    });
    expect(result.status).toBe("finished");
    expect(result["delta-monthly-cost"]).toBe("0.0");
    expect(result["prior-monthly-cost"]).toBe("0.0");
    expect(result["proposed-monthly-cost"]).toBe("0.0");
    expect(result["resources-count"]).toBe(0);
    expect(result["matched-resources-count"]).toBe(0);
    expect(result["unmatched-resources-count"]).toBe(0);
    expect(result["error-message"]).toBeNull();
    expect(result.resources).toEqual({});
  });

  it("supports errored status with error message", () => {
    const result = emptyCostEstimate("errored", {
      "queued-at": null,
      "pending-at": null,
      "finished-at": null,
    }, "Infracost not installed");
    expect(result.status).toBe("errored");
    expect(result["error-message"]).toBe("Infracost not installed");
    expect(result["delta-monthly-cost"]).toBe("0.0");
  });

  it("carries timestamps through", () => {
    const timestamps = {
      "queued-at": "queued",
      "pending-at": "pending",
      "finished-at": "finished",
    } as const;
    const result = emptyCostEstimate("skipped_due_to_targeting", timestamps);
    expect(result["status-timestamps"]).toBe(timestamps);
  });

  it("defaults errorMessage to null", () => {
    const result = emptyCostEstimate("canceled", {
      "queued-at": null, "pending-at": null, "finished-at": null,
    });
    expect(result["error-message"]).toBeNull();
  });
});

describe("parseInfracostOutput", () => {
  const timestamps = {
    "queued-at": null, "pending-at": null, "finished-at": new Date().toISOString(),
  };

  it("parses a minimal valid output", () => {
    const result = parseInfracostOutput(
      { totalMonthlyCost: "123.45", projects: [], summary: {} },
      timestamps,
    );
    expect(result.status).toBe("finished");
    expect(result["proposed-monthly-cost"]).toBe("123.45");
    expect(result["prior-monthly-cost"]).toBe("0.0");
    expect(result["delta-monthly-cost"]).toBe("123.45");
    expect(result["resources-count"]).toBe(0);
    expect(result["error-message"]).toBeNull();
  });

  it("computes delta when present", () => {
    const result = parseInfracostOutput(
      {
        totalMonthlyCost: "200",
        pastTotalMonthlyCost: "150",
        diffTotalMonthlyCost: "50",
        projects: [],
        summary: {},
      },
      timestamps,
    );
    expect(result["proposed-monthly-cost"]).toBe("200");
    expect(result["prior-monthly-cost"]).toBe("150");
    expect(result["delta-monthly-cost"]).toBe("50");
  });

  it("computes delta as diff of proposed and prior when not provided", () => {
    const result = parseInfracostOutput(
      {
        totalMonthlyCost: "200",
        pastTotalMonthlyCost: "150",
        projects: [],
        summary: {},
      },
      timestamps,
    );
    expect(result["delta-monthly-cost"]).toBe("50");
  });

  it("uses summary resource counts when available", () => {
    const result = parseInfracostOutput(
      {
        totalMonthlyCost: "50",
        projects: [],
        summary: {
          totalDetectedResources: 10,
          totalSupportedResources: 7,
          totalUnsupportedResources: 3,
        },
      },
      timestamps,
    );
    expect(result["resources-count"]).toBe(10);
    expect(result["matched-resources-count"]).toBe(7);
    expect(result["unmatched-resources-count"]).toBe(3);
  });

  it("throws on invalid JSON (non-object)", () => {
    expect(() => parseInfracostOutput("not-an-object", timestamps)).toThrow(
      "Infracost returned invalid JSON output.",
    );
  });

  it("throws on missing totalMonthlyCost", () => {
    expect(() => parseInfracostOutput({ projects: [], summary: {} }, timestamps)).toThrow(
      "Infracost output is missing a valid totalMonthlyCost.",
    );
  });

  it("passes currency from root", () => {
    const result = parseInfracostOutput(
      { totalMonthlyCost: "10", projects: [], summary: {}, currency: "GBP" },
      timestamps,
    );
    expect((result.resources as Record<string, unknown>)["currency"]).toBe("GBP");
  });

  it("handles project-level breakdown resources", () => {
    const result = parseInfracostOutput(
      {
        totalMonthlyCost: "100",
        projects: [
          {
            name: "prod",
            breakdown: { resources: [{ name: "ec2", monthlyCost: 50 }] },
          },
        ],
        summary: { totalDetectedResources: 1, totalSupportedResources: 1, totalUnsupportedResources: 0 },
      },
      timestamps,
    );
    expect(result["resources-count"]).toBe(1);
    expect(result["matched-resources-count"]).toBe(1);
  });
});
