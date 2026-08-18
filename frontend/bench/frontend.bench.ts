/**
 * Frontend pure-function benchmarks (runs with bun from the frontend dir).
 * Run: bun run bench/frontend.bench.ts [--json bench/baseline-frontend.json]
 */
import { suite, report } from "../../backend/bench/harness";
import { cn } from "../src/lib/utils";

// --- cn() (clsx + tailwind-merge; the most-called function in the app) ---

type Cv = Parameters<typeof cn>;

// Typical repeated calls: identical class lists across list rows.

// Heavier real-world shape: button variants + size + extra classes.
const buttonShapes: Cv[] = ["default", "outline", "ghost", "destructive", "secondary"].flatMap(
  (variant) => ["default", "sm", "lg"].map((size) => [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium",
    `btn-${variant}`,
    size !== "default" && `btn-${size}`,
    "focus-visible:outline-none disabled:pointer-events-none",
  ]),
);

// Typical repeated calls: identical class lists across list rows.
const repeatedInputs: Cv[] = Array.from({ length: 500 }, () => [
  "flex items-center gap-2",
  "text-sm text-muted-foreground",
  "px-2",
]);

// Real-world shape: base + conditional + className-style variable strings.
// When the conditional is truthy, every arg is a string and the cacheable
// path applies; when falsy the call falls through to raw twMerge.
const realWorldRows: Cv[] = Array.from({ length: 500 }, (_, i) => [
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium",
  i % 2 === 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
  i % 3 === 0 && "shadow-sm",
  `row-class-${i % 10}`,
]);

await suite("cn", {
  "500 repeated identical string calls": () => {
    for (const args of repeatedInputs) cn(...args);
  },
  "500 real-world rows (conditionals)": () => {
    for (const args of realWorldRows) cn(...args);
  },
  "15-button-variant matrix x 100": () => {
    for (let i = 0; i < 100; i += 1) {
      for (const args of buttonShapes) cn(...args);
    }
  },
});

// --- ChangeCalendar merged sort (replicated from routes/operations.ts) ---
type CalendarEntry = Readonly<{
  kind: "apply" | "auto-destroy" | "change-request";
  at: string;
  scheduled: boolean;
  workspaceId: string;
  runId?: string;
  changeRequestId?: string;
}>;
const KIND_ORDER: Readonly<Record<CalendarEntry["kind"], number>> = { apply: 0, "auto-destroy": 1, "change-request": 2 };
function entryId(entry: CalendarEntry): string {
  return String(entry.changeRequestId ?? entry.runId ?? entry.workspaceId ?? "entry");
}
function sortEntries(entries: CalendarEntry[]): CalendarEntry[] {
  return [...entries].sort((a, b): number => {
    const byAt = a.at.localeCompare(b.at);
    if (byAt !== 0) return byAt;
    const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (byKind !== 0) return byKind;
    return entryId(a).localeCompare(entryId(b));
  });
}
function calendarEntries(count: number): CalendarEntry[] {
  const entries: CalendarEntry[] = [];
  const base = 1_700_000_000_000;
  for (let i = 0; i < count; i += 1) {
    const kind = i % 3 === 0 ? "apply" : i % 3 === 1 ? "auto-destroy" : "change-request";
    entries.push({
      kind,
      at: new Date(base + ((i * 7919) % 604_800_000)).toISOString(),
      scheduled: i % 2 === 0,
      workspaceId: `ws-${i % 50}`,
      runId: kind === "apply" ? `run-${i}` : undefined,
      changeRequestId: kind === "change-request" ? `cr-${i}` : undefined,
    });
  }
  return entries;
}
const mixed200 = calendarEntries(200);
const mixed2000 = calendarEntries(2000);
await suite("calendar-sort", {
  "200 entries": () => {
    sortEntries(mixed200);
  },
  "2000 entries": () => {
    sortEntries(mixed2000);
  },
});

report();
