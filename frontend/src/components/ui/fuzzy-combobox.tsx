import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "../../lib/utils";

type ComboboxOption = Readonly<{
  id: string;
  label: string;
  hint?: string;
}>;

/**
 * Lightweight searchable combobox (base-ui-free, matches the minimal UI
 * style of this codebase). Type to filter with a subsequence fuzzy match;
 * ArrowUp/ArrowDown/Enter to select, Escape to close. Free text is always
 * allowed: picking nothing keeps the typed value, and an explicit "Use ..."
 * row commits custom input.
 */
export function FuzzyCombobox({
  value,
  options,
  onSelect,
  id,
  name,
  "aria-describedby": ariaDescribedBy,
  placeholder,
  allowCustom = true,
  emptyText = "No matches",
  className,
  inputClassName,
}: Readonly<{
  value: string;
  options: readonly ComboboxOption[];
  onSelect: (value: string) => void;
  id?: string;
  name?: string;
  "aria-describedby"?: string;
  placeholder?: string;
  allowCustom?: boolean;
  emptyText?: string;
  className?: string;
  inputClassName?: string;
}>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const focusRef = useRef<HTMLInputElement>(null);
  const generatedId = useId();
  const listId = id === undefined ? `fuzzy-combobox-list${generatedId}` : `${id}-list`;

  const selected = useMemo(
    (): ComboboxOption | undefined => options.find((option): boolean => option.id === value),
    [options, value],
  );

  const filtered = useMemo((): ComboboxOption[] => {
    const q = query.trim().toLowerCase();
    if (q === "") return options.slice(0, 200);
    const scored = options
      .map((option): Readonly<{ option: ComboboxOption; score: number }> => ({
        option,
        score: fuzzyScore(q, (option.label + " " + option.id).toLowerCase()),
      }))
      .filter((entry): boolean => entry.score > 0)
      .sort((a, b): number => b.score - a.score);
    return scored.slice(0, 200).map((entry): ComboboxOption => entry.option);
  }, [options, query]);

  const showCustom = allowCustom && query.trim() !== "" && !filtered.some((option): boolean => option.id === query.trim());

  useEffect((): (() => void) => {
    if (!open) return (): void => undefined;
    const onPointerDown = (event: MouseEvent): void => {
// SAFETY: the click target is a DOM node; contains() accepts Node.
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return (): void => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect((): void => {
    setHighlighted(0);
    if (listRef.current !== null) listRef.current.scrollTop = 0;
  }, [filtered.length, query, open]);

  const commit = (next: string): void => {
    onSelect(next);
    setQuery("");
    setOpen(false);
  };

  const rowCount = filtered.length + (showCustom ? 1 : 0);
  const optionId = (index: number): string => `${listId}-option-${index}`;

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!open && (event.key === "ArrowDown" || event.key === "Enter")) {
      setOpen(true);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((index): number => (rowCount === 0 ? 0 : (index + 1) % rowCount));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((index): number => (rowCount === 0 ? 0 : (index - 1 + rowCount) % rowCount));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (showCustom && highlighted === filtered.length) {
        commit(query.trim());
      } else if (filtered[highlighted] !== undefined) {
        commit(filtered[highlighted].id);
      }
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <div className="relative">
        <input
          ref={focusRef}
          id={id}
          name={name}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && rowCount > 0 ? optionId(highlighted) : undefined}
          aria-describedby={ariaDescribedBy}
          autoComplete="off"
          value={open ? query : selected?.label ?? value}
          placeholder={placeholder}
          onInput={(event): void => {
            setQuery(event.currentTarget.value);
            if (!open) setOpen(true);
          }}
          onFocus={(event): void => {
            setQuery(selected?.label ?? value);
            setOpen(true);
            event.currentTarget.select();
          }}
          onKeyDown={onKeyDown}
          className={cn(
            "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
            inputClassName,
          )}
        />
        <ChevronsUpDown
          className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
      </div>
      {open && (
        <ul
          id={listId}
          ref={listRef}
          role="listbox"
          aria-label="Suggestions"
          className="absolute z-50 mt-1 max-h-64 w-full min-w-56 overflow-y-auto rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          {rowCount === 0 && (
            <li className="px-2.5 py-1.5 text-xs text-muted-foreground" role="option" aria-disabled="true">
              {emptyText}
            </li>
          )}
          {filtered.map((option, index): React.JSX.Element => (
            <li key={option.id}>
              <button
                type="button"
                id={optionId(index)}
                role="option"
                aria-selected={index === highlighted}
                onMouseEnter={(): void => { setHighlighted(index); }}
                onClick={(): void => { commit(option.id); }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm",
                  index === highlighted ? "bg-accent text-accent-foreground" : "",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.hint !== undefined && (
                  <span className="shrink-0 truncate text-xs text-muted-foreground">{option.hint}</span>
                )}
                {option.id === value && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
              </button>
            </li>
          ))}
          {showCustom && (
            <li>
              <button
                type="button"
                id={optionId(filtered.length)}
                role="option"
                aria-selected={highlighted === filtered.length}
                onMouseEnter={(): void => { setHighlighted(filtered.length); }}
                onClick={(): void => { commit(query.trim()); }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm",
                  highlighted === filtered.length ? "bg-accent text-accent-foreground" : "",
                )}
              >
                <span className="min-w-0 flex-1 truncate">Use "{query.trim()}"</span>
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * Subsequence fuzzy score: query chars must appear in order in the text.
 * Earlier matches and consecutive runs score higher (0 = no match).
 */
export function fuzzyScore(query: string, text: string): number {
  if (query === "") return 1;
  let score = 0;
  let position = 0;
  let run = 0;
  for (let i = 0; i < query.length; i += 1) {
    const index = text.indexOf(query.charAt(i), position);
    if (index === -1) return 0;
    score += 1 + (index === position ? run + 1 : 0);
    if (index === position) run += 1;
    else run = 0;
    position = index + 1;
    score -= index * 0.01;
  }
  return score;
}