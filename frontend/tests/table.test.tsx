import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../src/components/ui/table";

afterEach((): void => {
  cleanup();
});

test("tables expose a keyboard-focusable horizontal scroll region", () => {
  const view = render(
    <Table scrollLabel="Workspace results">
      <TableHeader><TableRow><TableHead>Name</TableHead></TableRow></TableHeader>
      <TableBody><TableRow><TableCell>production</TableCell></TableRow></TableBody>
    </Table>,
  );
  const region = view.getByRole("region", { name: "Workspace results" });
  expect(region.getAttribute("tabindex")).toBe("0");
  expect(region.getAttribute("data-scrollable")).toBe("true");
});
