import { asc, eq, gt } from "drizzle-orm";
import { db } from "../src/db";
import { runs } from "../src/db/schema";
import { runVariablesForWrite } from "../src/lib/run-variables";

// Run with the server's database and encryption settings. Existing encrypted
// entries are untouched, making this safe to resume after interruption.
let cursor = "";
let updated = 0;
for (;;) {
  const batch = await db.query.runs.findMany({
    where: gt(runs.id, cursor), orderBy: [asc(runs.id)], limit: 100,
  });
  if (batch.length === 0) break;
  for (const run of batch) {
    cursor = run.id;
    if (!Array.isArray(run.variables)) continue;
    let changed = false;
    const variables = await Promise.all(run.variables.map(async (variable) => {
      const stored = variable as typeof variable & { readonly sensitive?: boolean; readonly valueEncrypted?: string };
      if (stored.sensitive !== true || stored.valueEncrypted !== undefined || typeof stored.value !== "string") return variable;
      changed = true;
      const [encrypted] = await runVariablesForWrite([stored]);
      if (encrypted === undefined) throw new Error("Missing encrypted run variable");
      return encrypted;
    }));
    if (changed) {
      await db.update(runs).set({ variables }).where(eq(runs.id, run.id));
      updated += 1;
    }
  }
}
console.log(`Encrypted sensitive variables in ${updated} run records.`);
process.exit(0);
