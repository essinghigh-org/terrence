import { describe, expect, it } from "bun:test";
import { app } from "../../src/app";

describe("TFE API Service Discovery", () => {
  it("should return the well-known discovery JSON", async () => {
    const response = await app.handle(
      new Request("http://localhost/.well-known/terraform.json")
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data["tfe.v2.1"]).toBe("/api/v2/");
    expect(data["tfe.v2.2"]).toBe("/api/v2/");
    expect(data["state.v2"]).toBe("/api/v2/");
  });
});
