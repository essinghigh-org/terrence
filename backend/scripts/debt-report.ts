/**
 * debt-report.ts — list all `ponytail` markers with file/line (kanban 26.7).
 *
 * Scans backend/src and frontend/src for lines containing a `ponytail:`
 * marker comment and prints them grouped by file. With `--fail`, exits 1
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
const MARKER = /ponytail\s*:/;

interface MarkerHit {
    file: string;
    line: number;
    text: string;
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
                    hits.push({ file: relative(process.cwd(), file), line: i + 1, text: lines[i].trim() });
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
        console.log(`${h.file}:${h.line}: ${h.text}`);
    }
    console.log(`\n${hits.length} ponytail marker(s) in ${ROOTS.join(", ")}.`);
}

process.exit(failOnDebt && hits.length > 0 ? 1 : 0);
