// Database driver resolution, shared by every module that must pick a
// backend at module-load time (db/index.ts, db/schema.ts).
//
// Resolved once here so schema.ts, db/index.ts and the boot path all agree
// on the active backend. Precedence (highest wins):
//   1. DATABASE_URL environment variable (postgres:// or postgresql://
//      selects postgres; anything else is treated as a sqlite URL)
//   2. boot configuration file (storage/terrence.json)
//   3. default: sqlite at <storage>/terrence.db
import { listenerSetting } from "../lib/runtime-config";
import { resolveDatabaseConfigWithOrigin, type DatabaseDriver } from "../lib/boot-config";

export const storageDir = listenerSetting("STORAGE_DIR");

const resolution = resolveDatabaseConfigWithOrigin(process.env, storageDir);
export const resolvedDatabase = resolution.configuration;
export const databaseConfigurationOrigin = resolution.origin;

export const databaseDriver: DatabaseDriver = resolvedDatabase.driver;

export const databaseUrl: string = resolvedDatabase.url;

export const isPostgres: boolean = databaseDriver === "postgres";
