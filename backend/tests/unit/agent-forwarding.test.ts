import { expect, test } from "bun:test";
import { forwardFetch } from "../../src/lib/agent-forwarding";

test("rejects private forwarded destinations despite the VCS private-URL opt-in", async () => {
  const previous = process.env["TERRENCE_ALLOW_PRIVATE_VCS_URLS"];
  process.env["TERRENCE_ALLOW_PRIVATE_VCS_URLS"] = "true";
  try {
    const response = await forwardFetch("agent-pool-test", "http://127.0.0.1:8080/oauth");
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("private");
  } finally {
    if (previous === undefined) delete process.env["TERRENCE_ALLOW_PRIVATE_VCS_URLS"];
    else process.env["TERRENCE_ALLOW_PRIVATE_VCS_URLS"] = previous;
  }
});
