import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type VcsRepoOption = {
  identifier: string;
  name: string;
  owner?: string;
};

type VcsRepoSelectorProps = {
  value: string;
  onValueChange: (value: string) => void;
  repositories: VcsRepoOption[];
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  name?: string;
};

export function VcsRepoSelector({
  value,
  onValueChange,
  repositories,
  loading = false,
  disabled = false,
  placeholder = "e.g. organization/repository",
  id,
  name,
}: Readonly<VcsRepoSelectorProps>): React.JSX.Element {
  const autoId = useId();
  const inputId = id ?? autoId;
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState(value);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  // Sync search when value changes externally
  useEffect((): void => {
    setSearch(value);
  }, [value]);

  // Filter repositories based on search text
  const filteredRepos = useMemo((): VcsRepoOption[] => {
    if (search === "") return repositories;
    const terms = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return repositories
      .map((repo: VcsRepoOption) => {
        const identifier = repo.identifier.toLocaleLowerCase();
        const haystack = `${repo.identifier} ${repo.name} ${repo.owner ?? ""}`.toLocaleLowerCase();
        const score = terms.reduce((total: number, term: string): number => {
          if (identifier.startsWith(term)) return total + 4;
          if (haystack.includes(term)) return total + 1;
          return -100;
        }, 0);
        return { repo, score };
      })
      .filter(({ score }): boolean => Number.isFinite(score) && score > 0)
      .sort((left, right): number => right.score - left.score || left.repo.identifier.localeCompare(right.repo.identifier))
      .map(({ repo }): VcsRepoOption => repo);
  }, [repositories, search]);

  // Close the dropdown on outside click
  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    const handleClick = (event: MouseEvent): void => {
      if (
        containerRef.current !== null &&
// SAFETY: the click target is a DOM node; contains() accepts Node.
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return (): void => {
      document.removeEventListener("mousedown", handleClick);
    };
  }, [open]);

  // Keep the highlighted item visible in the scrollable list
  useEffect((): void => {
    if (highlightedIndex >= 0 && listRef.current !== null) {
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
      const item = listRef.current.children[highlightedIndex] as HTMLElement | undefined;
      item?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex]);

  const handleSelect = useCallback(
    (repo: VcsRepoOption): void => {
      onValueChange(repo.identifier);
      setSearch(repo.identifier);
      setOpen(false);
      setHighlightedIndex(-1);
    },
    [onValueChange],
  );

  const handleInputChange = useCallback(
    (newValue: string): void => {
      setSearch(newValue);
      onValueChange(newValue);
      setOpen(true);
      setHighlightedIndex(-1);
    },
    [onValueChange],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (!open) {
        if (event.key === "ArrowDown" || event.key === "Enter") {
          setOpen(true);
          event.preventDefault();
        }
        return;
      }

      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          setHighlightedIndex((prev: number): number =>
            prev < filteredRepos.length - 1 ? prev + 1 : 0,
          );
          break;
        }
        case "ArrowUp": {
          event.preventDefault();
          setHighlightedIndex((prev: number): number =>
            prev > 0 ? prev - 1 : filteredRepos.length - 1,
          );
          break;
        }
        case "Enter": {
          event.preventDefault();
          const selectedRepo = filteredRepos[highlightedIndex];
          if (selectedRepo !== undefined) {
            handleSelect(selectedRepo);
          }
          break;
        }
        case "Escape": {
          event.preventDefault();
          setOpen(false);
          break;
        }
        case "Tab": {
          setOpen(false);
          break;
        }
      }
    },
    [open, filteredRepos, highlightedIndex, handleSelect],
  );

  const showDropdown = open && !loading && repositories.length > 0 && filteredRepos.length > 0;
  const hasRepoList = !loading && repositories.length > 0 && filteredRepos.length > 0;

  return (
    <div className="relative" ref={containerRef}>
      <div className="relative">
        <Input
          id={inputId}
          name={name}
          autoComplete="off"
          ref={inputRef}
          value={search}
          onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
            handleInputChange(event.currentTarget.value);
          }}
          onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
            handleInputChange(event.currentTarget.value);
          }}
          onFocus={(): void => {
            if (!disabled && !loading && hasRepoList) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder={
            loading ? "Fetching accessible repositories…" : placeholder
          }
          disabled={disabled || loading}
          className={cn("pr-8")}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showDropdown}
          aria-controls={
            showDropdown ? `${inputId}-listbox` : undefined
          }
          aria-activedescendant={
            highlightedIndex >= 0 && showDropdown
              ? `${inputId}-option-${highlightedIndex}`
              : undefined
          }
          data-slot="vcs-repo-combobox"
        />
        {/* Loading spinner or chevron indicator */}
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
          {loading ? (
            <Spinner className="size-4" />
          ) : (
            <svg
              className={cn(
                "size-4 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          )}
        </span>
      </div>

      {/* Dropdown list */}
      {showDropdown && (
        <ul
          id={`${inputId}-listbox`}
          ref={listRef}
          role="listbox"
          className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md"
        >
          {filteredRepos.map(
            (repo: VcsRepoOption, index: number): React.JSX.Element => (
              <li
                key={repo.identifier}
                id={`${inputId}-option-${index}`}
                role="option"
                aria-selected={highlightedIndex === index}
                className={cn(
                  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none",
                  highlightedIndex === index
                    ? "bg-accent text-accent-foreground"
                    : "text-popover-foreground",
                )}
                onMouseDown={(event: React.MouseEvent): void => {
                  event.preventDefault();
                  handleSelect(repo);
                }}
                onMouseEnter={(): void => { setHighlightedIndex(index); }}
              >
                <span className="min-w-0 truncate">
                  <span className="block truncate font-medium">{repo.identifier}</span>
                  {repo.name !== repo.identifier && (
                    <span className="block truncate text-xs text-muted-foreground">{repo.name}</span>
                  )}
                </span>
              </li>
            ),
          )}
        </ul>
      )}

      {/* No results state */}
      {open &&
        !loading &&
        repositories.length > 0 &&
        filteredRepos.length === 0 && (
          <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-popover p-2 shadow-md">
            <p className="text-sm text-muted-foreground">
              No repositories match &ldquo;{search}&rdquo;
            </p>
          </div>
        )}
    </div>
  );
}
