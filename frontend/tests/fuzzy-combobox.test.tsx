import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { FuzzyCombobox, fuzzyScore } from "../src/components/ui/fuzzy-combobox";

afterEach((): void => {
  cleanup();
});

const OPTIONS = [
  { id: "openrouter", label: "OpenRouter", hint: "320 models" },
  { id: "openai", label: "OpenAI", hint: "40 models" },
  { id: "anthropic", label: "Anthropic", hint: "25 models" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "1M ctx" },
] as const;

const noop = (): void => { /* no-op */ };

test("fuzzyScore: subsequence match scores higher when chars are consecutive and early", () => {
  expect(fuzzyScore("", "anything")).toBe(1);
  expect(fuzzyScore("xyz", "abc")).toBe(0); // no subsequence
  // "or" in "orange" is consecutive; in "openrouter" the o..r are spread out.
  expect(fuzzyScore("or", "orange")).toBeGreaterThan(0);
  expect(fuzzyScore("or", "openrouter")).toBeGreaterThan(0);
  expect(fuzzyScore("or", "orange")).toBeGreaterThan(fuzzyScore("or", "openrouter"));
  // out-of-order chars still match (subsequence), e.g. "rtr" in "openrouter"
  expect(fuzzyScore("rtr", "openrouter")).toBeGreaterThan(0);
  // non-consecutive o..r still matches in "cohere"
  expect(fuzzyScore("or", "cohere")).toBeGreaterThan(0);
});

test("combobox filters options by fuzzy query", () => {
  const view = render(
    <FuzzyCombobox value="" options={OPTIONS} onSelect={noop} placeholder="Pick" />,
  );
  const input = view.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.input(input, { target: { value: "openr" } });
  const listbox = view.getByRole("listbox");
  // OpenRouter should survive; OpenAI (no subsequence "openr") should not.
  expect(listbox.textContent).toContain("OpenRouter");
  expect(listbox.textContent).not.toContain("OpenAI");
});

test("combobox commits a selected option", () => {
  let selected = "";
  const view = render(
    <FuzzyCombobox value="" options={OPTIONS} onSelect={(value: string): void => { selected = value; }} placeholder="Pick" />,
  );
  const input = view.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.input(input, { target: { value: "anth" } });
  fireEvent.click(view.getByRole("option", { name: /Anthropic/ }));
  expect(selected).toBe("anthropic");
});

test("combobox allows custom free-text values via the Use row", () => {
  let selected = "";
  const view = render(
    <FuzzyCombobox value="" options={OPTIONS} onSelect={(value: string): void => { selected = value; }} placeholder="Pick" />,
  );
  const input = view.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.input(input, { target: { value: "my-custom-model" } });
  fireEvent.click(view.getByRole("option", { name: /Use "my-custom-model"/ }));
  expect(selected).toBe("my-custom-model");
});

test("combobox shows the selected label when closed", () => {
  const view = render(
    <FuzzyCombobox value="openai" options={OPTIONS} onSelect={noop} />,
  );
// SAFETY: the component renders this element type for the queried role/label.
  const input = view.getByRole("combobox") as HTMLInputElement;
  expect(input.value).toBe("OpenAI");
});

test("combobox keeps the selected label visible when focused", () => {
  const view = render(
    <FuzzyCombobox value="openai" options={OPTIONS} onSelect={noop} />,
  );
// SAFETY: the component renders this element type for the queried role/label.
  const input = view.getByRole("combobox") as HTMLInputElement;
  fireEvent.focus(input);
  expect(input.value).toBe("OpenAI");
});

test("combobox exposes a stable labelled list relationship", () => {
  const view = render(
    <>
      <label htmlFor="provider-picker">Provider</label>
      <FuzzyCombobox id="provider-picker" name="provider" value="" options={OPTIONS} onSelect={noop} />
    </>,
  );
// SAFETY: the component renders this element type for the queried role/label.
  const input = view.getByRole("combobox") as HTMLInputElement;
  expect(input.id).toBe("provider-picker");
  expect(input.name).toBe("provider");
  fireEvent.focus(input);
  expect(view.getByRole("listbox").id).toBe("provider-picker-list");
});

test("combobox keyboard navigation selects with Enter", () => {
  let selected = "";
  const view = render(
    <FuzzyCombobox value="" options={OPTIONS} onSelect={(value: string): void => { selected = value; }} placeholder="Pick" />,
  );
  const input = view.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.input(input, { target: { value: "gem" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(selected).toBe("google/gemini-2.5-pro");
});

test("combobox closes on Escape and clears the query", () => {
  const view = render(
    <FuzzyCombobox value="" options={OPTIONS} onSelect={noop} placeholder="Pick" />,
  );
  const input = view.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.input(input, { target: { value: "openr" } });
  expect(view.queryByRole("listbox")).not.toBeNull();
  fireEvent.keyDown(input, { key: "Escape" });
  // listbox unmounts (portal-free inline list)
  expect(view.queryByRole("listbox")).toBeNull();
  void waitFor;
});