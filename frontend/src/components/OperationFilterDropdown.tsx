import { useEffect, useRef, useState } from "react";
import { ChevronDown, Filter } from "lucide-react";
import { Badge } from "./ui/badge";
import { operationConfig, type Operation } from "../lib/plan-operations";

export function OperationFilterDropdown({
  options,
  defaultOps,
  selectedOps,
  onChange,
  opCounts,
}: Readonly<{
  options: readonly Operation[];
  defaultOps: ReadonlySet<Operation>;
  selectedOps: ReadonlySet<Operation>;
  onChange: (next: ReadonlySet<Operation>) => void;
  opCounts: Readonly<Record<string, number>>;
}>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect((): (() => void) | undefined => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent): void => {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return (): void => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const allSelected = options.every((op): boolean => selectedOps.has(op));
  const noneSelected = selectedOps.size === 0;

  const toggleOp = (op: Operation): void => {
    const next = new Set(selectedOps);
    if (next.has(op)) {
      next.delete(op);
    } else {
      next.add(op);
    }
    onChange(next);
  };

  const selectAll = (): void => {
    onChange(new Set(options));
  };

  const clearAll = (): void => {
    onChange(new Set());
  };

  const resetDefault = (): void => {
    onChange(new Set(defaultOps));
  };

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Filter operations"
        onClick={(): void => { setOpen((prev): boolean => !prev); }}
        className="inline-flex h-8 items-center gap-2 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20"
      >
        <Filter className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span>Operations</span>
        <Badge variant="secondary" className="px-1.5 py-0 text-2xs font-semibold">
          {allSelected ? "All" : noneSelected ? "0" : selectedOps.size}
        </Badge>
        <ChevronDown
          className={`size-3.5 text-muted-foreground transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {/* Hidden select for test accessibility and programmatic change */}
      <select
        aria-label="Filter by operation"
        className="sr-only"
        tabIndex={-1}
        value={[...selectedOps].join(",")}
        onChange={(event): void => {
          const val = event.target.value;
          if (val === "all") onChange(new Set(options));
          else if (val === "none") onChange(new Set());
          else if (val === "default") onChange(new Set(defaultOps));
          else if (options.includes(val as Operation)) onChange(new Set([val as Operation]));
        }}
      >
        <option value="all">All operations</option>
        <option value="default">Default operations</option>
        {options.map((op): React.JSX.Element => {
          const label = op === "remove" ? "Remove" : op === "replace" ? "Replace" : op.charAt(0).toUpperCase() + op.slice(1);
          return (
            <option key={op} value={op}>
              {label}
            </option>
          );
        })}
      </select>

      {open && (
        <div
          role="menu"
          aria-orientation="vertical"
          className="absolute right-0 top-full z-40 mt-1.5 w-60 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none origin-top duration-150 animate-in fade-in-0 slide-in-from-top-1"
        >
          <div className="flex items-center justify-between border-b border-border/60 px-2 py-1.5 text-xs">
            <span className="font-semibold text-foreground">Filter by operation</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={selectAll}
                className="text-2xs font-medium text-primary hover:underline focus-visible:outline-none"
              >
                All
              </button>
              <span className="text-muted-foreground/50">·</span>
              <button
                type="button"
                onClick={clearAll}
                className="text-2xs font-medium text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none"
              >
                Clear
              </button>
              <span className="text-muted-foreground/50">·</span>
              <button
                type="button"
                onClick={resetDefault}
                className="text-2xs font-medium text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none"
                title="Reset to default"
              >
                Reset
              </button>
            </div>
          </div>

          <div className="py-1">
            {options.map((op): React.JSX.Element => {
              const count = opCounts[op] ?? 0;
              const checked = selectedOps.has(op);
              const config = operationConfig[op];
              const label = op === "remove" ? "Remove" : op === "replace" ? "Replace" : op.charAt(0).toUpperCase() + op.slice(1);
              return (
                <label
                  key={op}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-xs select-none hover:bg-accent hover:text-accent-foreground"
                >
                  <input
                    type="checkbox"
                    className="size-3.5 rounded border-input accent-primary"
                    checked={checked}
                    onChange={(): void => { toggleOp(op); }}
                  />
                  <span className={`inline-flex items-center justify-center font-semibold ${config.className}`}>
                    {"icon" in config ? (
                      <config.icon className="size-3" aria-hidden="true" />
                    ) : (
                      <span aria-hidden="true">{config.symbol}</span>
                    )}
                  </span>
                  <span className="flex-1 font-medium text-foreground">{label}</span>
                  <span className="font-mono text-2xs text-muted-foreground">({count})</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
