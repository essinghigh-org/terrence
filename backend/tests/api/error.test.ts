import { describe, expect, it } from "bun:test";
import { app } from "../../src/app";

describe("TFE API Error Handling", () => {
  it("should return a JSON API formatted 404 error", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/v2/this-does-not-exist")
    );

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.errors).toBeDefined();
    expect(data.errors[0].status).toBe("404");
    expect(data.errors[0].title).toBe("Not Found");
  });
});
