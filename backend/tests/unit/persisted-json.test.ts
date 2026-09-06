import { describe, expect, test } from "bun:test";
import {
  decodePersistedArtifact,
  decodePersistedJobPayload,
  decodePersistedRunInputs,
  encodePersistedArtifact,
  encodePersistedJobPayload,
  encodePersistedRunInputs,
  parsePersistedRunInputs,
  parsePersistedStatusMetadata,
} from "../../src/lib/validation";
import { PersistedJsonValidationError } from "../../src/lib/db-json";

function persistedError(action: () => unknown): PersistedJsonValidationError {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof PersistedJsonValidationError) return error;
    throw error;
  }
  throw new Error("expected persisted JSON validation to fail");
}

describe("versioned persisted JSON adapters", () => {
  test("upgrade the oldest raw run input representation and isolate extensions", () => {
    const value = parsePersistedRunInputs({
      targetAddrs: [],
      replaceAddrs: null,
      invokeActionAddrs: null,
      variables: [{ key: "region", value: "eu", futureFlag: true }],
      futureField: { retained: true },
    }, 0, "run-legacy");

    expect(value.targetAddrs).toEqual([]);
    expect(value.variables?.[0]).toEqual({
      key: "region",
      value: "eu",
      category: "terraform",
      sensitive: false,
      extensions: { futureFlag: true },
    });
    expect(value.extensions).toEqual({ futureField: { retained: true } });
  });

  test("distinguishes missing, null, and empty values", () => {
    expect(persistedError(() => parsePersistedRunInputs({ replaceAddrs: [], invokeActionAddrs: [], variables: [] }, 1, "run-missing"))).toMatchObject({ code: "missing", field: "runs.targetAddrs", rowId: "run-missing" });
    expect(persistedError(() => parsePersistedStatusMetadata(null, 1, "status-null", false))).toMatchObject({ code: "null", field: "statusTimestamps" });
    expect(parsePersistedRunInputs({ targetAddrs: [], replaceAddrs: [], invokeActionAddrs: [], variables: [] }, 1).variables).toEqual([]);
  });

  test("round trips supported values and unknown envelope extensions", () => {
    const run = {
      targetAddrs: null,
      replaceAddrs: [],
      invokeActionAddrs: null,
      variables: [],
    } as const;
    const encoded = encodePersistedRunInputs(run, { future: { preserve: "yes" } });
    const decoded = decodePersistedRunInputs({ ...encoded, futureEnvelopeField: "also-preserve" }, "run-round-trip");
    expect(decoded.value).toEqual(run);
    expect(decoded.extensions).toEqual({ future: { preserve: "yes" }, futureEnvelopeField: "also-preserve" });
  });

  test("keeps artifact and job payload extensions out of execution parsing", () => {
    const artifact = decodePersistedArtifact(encodePersistedArtifact({ resources: [] }, { futureArtifact: { value: 1 } }), "artifact-1");
    expect(artifact.value).toEqual({ resources: [] });
    expect(artifact.extensions).toEqual({ futureArtifact: { value: 1 } });

    const job = decodePersistedJobPayload("explorer-inventory", encodePersistedJobPayload({ workspaceId: "ws-1" }, { futureInstruction: "ignore" }), "job-1");
    expect(job.value).toEqual({ workspaceId: "ws-1" });
    expect(job.extensions).toEqual({ futureInstruction: "ignore" });
  });

  test("reports unsupported stored schema versions with row context", () => {
    const error = persistedError(() => parsePersistedRunInputs({ targetAddrs: [], replaceAddrs: [], invokeActionAddrs: [], variables: [] }, 99, "run-old"));
    expect(error).toMatchObject({ code: "version", field: "runs.inputs", rowId: "run-old", schemaVersion: 99 });
  });
});
