import { defineConfig } from "drizzle-kit";

// PostgreSQL migration generation for the second backend. The static schema
// (src/db/schema-pg.ts) is generated from the canonical sqlite schema by
// scripts/generate-pg-schema.ts; the runtime mirror (db/pg-convert.ts) is
// the app's pg schema. Generated migrations land in drizzle/pg and are
// applied at boot / in the test harness when the postgres driver is active:
//   bunx drizzle-kit generate --config drizzle.config.pg.ts
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema-pg.ts",
  out: "./drizzle/pg",
});
