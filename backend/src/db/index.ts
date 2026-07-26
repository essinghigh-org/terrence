import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import * as schema from './schema';

const storageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, '../../storage'));
await mkdir(storageDir, { recursive: true });

const sqlite = createClient({
  url: process.env.DATABASE_URL ?? `file:${join(storageDir, 'terrence.db')}`,
});
await sqlite.executeMultiple(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
`);

export const db = drizzle(sqlite, { schema });
await migrate(db, { migrationsFolder: join(import.meta.dir, '../../drizzle') });
await sqlite.execute('PRAGMA foreign_keys = ON');
