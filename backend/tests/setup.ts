// Test setup: redirect database to an isolated temp directory so tests
// never touch the production database.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV ??= "test";
process.env.TERRENCE_ENABLE_LOCAL_SIGNUP ??= "true";

const testDir = mkdtempSync(join(tmpdir(), "terrence-test-"));
process.env.DATABASE_URL ??= `file:${join(testDir, "terrence.db")}`;
process.env.STORAGE_DIR ??= join(testDir, "storage");
