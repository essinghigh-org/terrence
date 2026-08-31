import { expect, test } from "bun:test";

import { newRunId, RUN_ID_LENGTH } from "../../src/lib/run-id";

test("generates canonical run identifiers", (): void => {
  const id = newRunId();
  expect(id).toMatch(/^run-[a-f0-9]{14}$/);
  expect(id).toHaveLength(RUN_ID_LENGTH);
});
