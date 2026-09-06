import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AdminDatabaseMigration } from "../src/views/AdminDatabaseMigration";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

const json = (data: JsonValue): Response => new Response(JSON.stringify(data), {
  headers: { "Content-Type": "application/vnd.api+json" },
});

const urlOf = (input: string | URL | Request): string =>
  isString(input) ? input : input instanceof URL ? input.toString() : input.url;

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("shows durable migration checkpoints and explains a blocked cutover", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/admin/db-migration/status") {
      return json({
        data: {
          wizard: {
            id: "migration-1",
            phase: "ready_to_switch",
            createdAt: "2026-09-06T11:00:00.000Z",
            updatedAt: "2026-09-06T11:05:00.000Z",
            targetUrl: "postgres://internal",
            targetMasked: "postgres://***",
            steps: [
              "compatibility",
              "maintenance",
              "drain",
              "checkpoint",
              "schema",
              "copy",
              "verify",
            ].map((key) => ({
              key,
              status: "passed",
              startedAt: "2026-09-06T11:00:00.000Z",
              finishedAt: "2026-09-06T11:04:00.000Z",
              detail: null,
              error: null,
            })),
            verification: null,
            report: null,
            error: null,
            copyProgress: null,
          },
          running: false,
          "source-database": { path: "/var/lib/terrence/terrence.db", memory: false },
          "restart-disabled": false,
          "environment-database-url": "DATABASE_URL is set; the boot configuration cannot take effect.",
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const view = render(
    <MemoryRouter>
      <AdminDatabaseMigration />
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("Ready to switch")).toBeTruthy();
  });
  expect(view.getByText("Verified and reversible")).toBeTruthy();
  for (const label of [
    "Preflight",
    "Write quiescence",
    "Transfer",
    "Consistency checks",
    "Cutover",
    "Post-cutover validation",
  ]) {
    expect(view.getByText(label)).toBeTruthy();
  }

  const switchButton = view.getByRole("button", { name: /Switch to PostgreSQL/ });
  expect((switchButton as HTMLButtonElement).disabled).toBeTrue();
  expect(view.getByText(/Switch is unavailable while DATABASE_URL is set/)).toBeTruthy();
  expect(view.getByText("Persisted checkpoint")).toBeTruthy();
  expect(view.getAllByText("postgres://***")).toHaveLength(2);
});
