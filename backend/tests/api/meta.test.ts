import { expect, test } from "bun:test";
import { app } from "../../src/app";

type SandboxMeta = {
  data?: {
    "run-sandbox"?: {
      enabled: boolean;
      available: boolean;
      abi: number;
      reason: string | null;
      docs: string;
    };
  };
};

test("GET /api/v2/meta reports the run sandbox status", async () => {
  const response = await app.handle(new Request("http://localhost/api/v2/meta"));
  expect(response.status).toBe(200);
  const payload = (await response.json()) as SandboxMeta;
  const sandbox = payload.data?.["run-sandbox"];
  expect(sandbox).toBeDefined();
  expect(sandbox?.docs).toContain("landlock");
  // On any kernel the response must be well-formed; availability depends on
  // the host, so only assert the shape here.
  expect(typeof sandbox?.enabled).toBe("boolean");
  expect(typeof sandbox?.available).toBe("boolean");
  expect(typeof sandbox?.abi).toBe("number");
  if (sandbox?.enabled) {
    expect(sandbox.available).toBe(sandbox.abi >= 1);
  }
});
