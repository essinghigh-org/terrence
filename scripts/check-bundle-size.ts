import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const rootDist = join(import.meta.dir, "../frontend/dist");
const cwdDist = join(process.cwd(), "frontend/dist");
const localDist = join(process.cwd(), "dist");

let dist = "";
if (existsSync(cwdDist)) {
  dist = cwdDist;
} else if (existsSync(rootDist)) {
  dist = rootDist;
} else if (existsSync(localDist)) {
  dist = localDist;
} else {
  console.error("frontend/dist is missing");
  process.exit(1);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry): string[] => {
    const fullPath = join(dir, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

const files = walk(dist);
const totalBytes = files.reduce((sum: number, file: string): number => sum + statSync(file).size, 0);
const budgetBytes = 6 * 1024 * 1024; // 6 MiB budget

const totalMiB = (totalBytes / (1024 * 1024)).toFixed(2);
const budgetMiB = (budgetBytes / (1024 * 1024)).toFixed(2);

console.log(`bundle total ${totalMiB} MiB (budget ${budgetMiB} MiB)`);

if (totalBytes > budgetBytes) {
  const overKiB = ((totalBytes - budgetBytes) / 1024).toFixed(0);
  console.error(`bundle exceeds budget by ${overKiB} KiB`);
  process.exit(1);
}
