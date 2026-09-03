// Database driver resolution, shared by every module that must pick a
// backend at module-load time (db/index.ts, db/schema.ts).
//
// Resolved once here so schema.ts, db/index.ts and the boot path all agree
// on the active backend. Precedence (highest wins):
//   1. DATABASE_URL environment variable (postgres:// or postgresql://
//      selects postgres; anything else is treated as a sqlite URL)
//   2. boot configuration file (storage/terrence.json)
//   3. default: sqlite at <storage>/terrence.db
import { join, resolve } from "node:path";
import { resolveDatabaseConfig, type DatabaseDriver } from "../lib/boot-config";

export const storageDir = resolve(
  process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"),
);

export const resolvedDatabase = resolveDatabaseConfig(process.env, storageDir);

export const databaseDriver: DatabaseDriver = resolvedDatabase.driver;

export const databaseUrl: string = resolvedDatabase.url;

export const isPostgres: boolean = databaseDriver === "postgres";
