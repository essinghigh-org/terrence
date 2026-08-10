/**
 * debt-report.ts — list all `ponytail` markers with file/line (kanban 26.7).
 *
 * Scans backend/src and frontend/src for lines containing a `ponytail:`
 * marker comment and prints them grouped by file. Markers may carry a
 * mechanical category suffix — `ponytail(perf):`, `ponytail(scale):`,
 * `ponytail(compat):`, etc. (kanban 26.6) — which the report enumerates so
 * the debt backlog can be queried mechanically. With `--fail`, exits 1
 * when any markers exist (for CI/pre-commit gate use); the default exit
 * code is 0 (informational listing).
 *
 * Usage:
 *   bun run backend/scripts/debt-report.ts
 *   bun run backend/scripts/debt-report.ts --json   # machine-readable output
 *   bun run backend/scripts/debt-report.ts --fail   # exit 1 if debt exists
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["backend/src", "frontend/src"];
const MARKER = /ponytail\s*:\s*/;
// ponytail(perf):  ponytail(scale):  ponytail(compat):  ...
const CATEGORY = /ponytail\(\s*([a-z0-9-]+)\s*\)\s*:/;

interface MarkerHit {
    file: string;
    line: number;
    text: string;
    category: string | null;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === "node_modules" || name === ".codegraph") continue;
        const st = statSync(p);
        if (st.isDirectory()) {
            out.push(...walk(p));
        } else if (/\.(ts|tsx)$/.test(name)) {
            out.push(p);
        }
    }
    return out;
}

function collect(): MarkerHit[] {
    const hits: MarkerHit[] = [];
    for (const root of ROOTS) {
        if (!statSync(root, { throwIfNoEntry: false })) continue;
        for (const file of walk(root)) {
            const lines = readFileSync(file, "utf8").split("\n");
            for (let i = 0; i < lines.length; i++) {
                if (MARKER.test(lines[i])) {
                    const categoryMatch = lines[i].match(CATEGORY);
                    hits.push({
                        file: relative(process.cwd(), file),
                        line: i + 1,
                        text: lines[i].trim(),
                        category: categoryMatch?.[1] ?? null,
                    });
                }
            }
        }
    }
    return hits;
}

const json = process.argv.includes("--json");
const failOnDebt = process.argv.includes("--fail");
const hits = collect();

if (json) {
    console.log(JSON.stringify(hits, null, 2));
} else {
    if (hits.length === 0) {
        console.log("No ponytail markers found. Codebase is clean.");
    }
    for (const h of hits) {
        const tag = h.category === null ? "ponytail" : `ponytail(${h.category})`;
        console.log(`${h.file}:${h.line}: [${tag}] ${h.text}`);
    }
    console.log(`\n${hits.length} ponytail marker(s) in ${ROOTS.join(", ")}.`);
    if (hits.length > 0) {
        const categories = new Map<string, number>();
        for (const h of hits) {
            const key = h.category ?? "uncategorized";
            categories.set(key, (categories.get(key) ?? 0) + 1);
        }
        console.log("By category:");
        for (const [category, count] of [...categories.entries()].sort()) {
            console.log(`  ${category}: ${count}`);
        }
    }
}

process.exit(failOnDebt && hits.length > 0 ? 1 : 0);
