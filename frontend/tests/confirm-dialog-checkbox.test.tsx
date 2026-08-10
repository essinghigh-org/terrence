import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";

import { ConfirmDialog } from "../src/components/ui/confirm-dialog";

afterEach((): void => {
  cleanup();
});

test("confirm stays disabled until the checkbox is ticked (kanban 26.17)", () => {
  let confirmed = false;
  const view = render(
    <ConfirmDialog
      open={true}
      onOpenChange={(): void => {}}
      title="Delete Organization"
      description="This permanently deletes the organization and all of its data."
      confirmText="Delete Organization"
      requireCheckbox="I understand this permanently deletes the organization and all of its data."
      onConfirm={(): void => {
        confirmed = true;
      }}
    />,
  );

  const confirmButton = view.getByRole("button", { name: "Delete Organization" }) as HTMLButtonElement;
  const checkbox = view.getByRole("checkbox") as HTMLInputElement;

  expect(confirmButton.disabled).toBeTrue();

  fireEvent.click(checkbox);
  expect(checkbox.checked).toBeTrue();
  expect(confirmButton.disabled).toBeFalse();

  fireEvent.click(confirmButton);
  expect(confirmed).toBeTrue();
});

test("checkbox requirement resets when the dialog closes and reopens (kanban 26.17)", () => {
  function Wrapper(): React.JSX.Element {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={(): void => setOpen((v): boolean => !v)}>Toggle</button>
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="Delete Organization"
          requireCheckbox="I understand the consequences."
          onConfirm={(): void => {}}
        />
      </>
    );
  }

  const view = render(<Wrapper />);

  const confirmButton = view.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
  fireEvent.click(view.getByRole("checkbox") as HTMLInputElement);
  expect(confirmButton.disabled).toBeFalse();

  // Close the dialog, reopen it: the checkbox must be unticked again.
  fireEvent.click(view.getByRole("button", { name: "Toggle" }));
  fireEvent.click(view.getByRole("button", { name: "Toggle" }));

  const freshCheckbox = view.getByRole("checkbox") as HTMLInputElement;
  const freshConfirmButton = view.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
  expect(freshCheckbox.checked).toBeFalse();
  expect(freshConfirmButton.disabled).toBeTrue();
});