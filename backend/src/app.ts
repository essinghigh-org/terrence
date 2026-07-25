import { Elysia } from "elysia";

export const app = new Elysia()
  .get("/", () => "Terraform Enterprise Homelab Clone API");

// Endpoints are not implemented yet to fulfill the TDD requirement.
// The tests will fail against this app instance.
