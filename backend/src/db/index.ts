import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './schema';

const sqlite = createClient({ url: 'file:./local.db' });
export const db = drizzle(sqlite, { schema });
