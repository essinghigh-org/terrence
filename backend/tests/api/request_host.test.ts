import { test, expect } from "bun:test";
import { app } from "../../src/app";

test("public listener rejects unknown hostnames before routing or issuing cookies", async () => {
  for (const path of ["/", "/api/v2/ping", "/api/v2/users/login", "/api/v2/users/refresh", "/users/saml/auth"]) {
    const response = await app.handle(new Request(`http://unconfigured.example${path}`));
    expect(response.status).toBe(421);
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  const mismatch = await app.handle(
    new Request("http://localhost/api/v2/ping", { headers: { Host: "unconfigured.example" } }),
  );
  expect(mismatch.status).toBe(421);
});

test("public URL and explicit aliases work alongside literal-address health probes", async () => {
  const previous = process.env["PUBLIC_URL"];
  const previousHosts = process.env["TERRENCE_ALLOWED_HOSTS"];
  process.env["PUBLIC_URL"] = "https://service.example";
  process.env["TERRENCE_ALLOWED_HOSTS"] = "alias.example";
  try {
    for (const host of ["service.example", "alias.example", "localhost", "127.0.0.1", "[::1]"]) {
      expect((await app.handle(new Request(`http://${host}/api/v2/ping`))).status).toBe(200);
    }
    expect((await app.handle(new Request("http://service.example.other/api/v2/ping"))).status).toBe(421);
  } finally {
    if (previous === undefined) delete process.env["PUBLIC_URL"];
    else process.env["PUBLIC_URL"] = previous;
    if (previousHosts === undefined) delete process.env["TERRENCE_ALLOWED_HOSTS"];
    else process.env["TERRENCE_ALLOWED_HOSTS"] = previousHosts;
  }
});
