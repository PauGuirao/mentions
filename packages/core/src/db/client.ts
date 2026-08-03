/**
 * Drizzle over D1. Ops keep receiving the raw D1Database binding (so worker
 * callers and tests are untouched) and wrap it per call — drizzle() is pure
 * construction, no IO, so this costs nothing.
 */
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof getDb>;
