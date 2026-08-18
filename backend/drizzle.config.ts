import { defineConfig } from 'drizzle-kit';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const storageDir = resolve(process.env.STORAGE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), 'storage'));

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? `file:${join(storageDir, 'terrence.db')}`,
  }
});
