/**
 * Test-only D1Database backed by better-sqlite3 running the REAL SQL
 * migrations, so ops execute against the actual schema — a column drifting
 * between migrations and src/db/schema.ts fails tests instead of production.
 *
 * Not a full D1 emulation: it implements what the ops layer and drizzle's D1
 * driver actually use (prepare/bind/first/all/raw/run, batch, exec). D1
 * enforces foreign keys, so the pragma is switched on to match.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations', import.meta.url));

type Row = Record<string, unknown>;

interface ShimStatement {
  bind(...params: unknown[]): ShimStatement;
  first<T = Row>(column?: string): Promise<T | null>;
  run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }>;
  all<T = Row>(): Promise<{ results: T[]; success: true; meta: { changes: number } }>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

export function createTestD1(): D1Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');

  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith('.sql')) continue;
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }

  /** D1 numbered placeholders (?1, ?2, possibly reused) are named params to
   *  better-sqlite3, so rewrite them to @pN and bind an object; drizzle's
   *  generated SQL uses plain positional `?` and passes through untouched.
   *  D1 binds undefined as NULL; better-sqlite3 rejects it, so coerce. */
  const prep = (sqlText: string, params: unknown[]) => {
    const values = params.map((v) => (v === undefined ? null : v));
    if (/\?\d+/.test(sqlText)) {
      const named = sqlText.replace(/\?(\d+)/g, '@p$1');
      const bindings = Object.fromEntries(values.map((v, i) => [`p${i + 1}`, v]));
      return { stmt: sqlite.prepare(named), args: [bindings] as unknown[] };
    }
    return { stmt: sqlite.prepare(sqlText), args: values };
  };

  const makeStatement = (sql: string, params: unknown[]): ShimStatement => ({
    bind: (...next: unknown[]) => makeStatement(sql, next),
    first: async <T = Row,>(column?: string) => {
      const { stmt, args } = prep(sql, params);
      const row = stmt.get(...args) as Row | undefined;
      if (row === undefined) return null;
      return (column === undefined ? row : row[column]) as T;
    },
    run: async () => {
      const { stmt, args } = prep(sql, params);
      if (stmt.reader) {
        // D1 allows .run() on row-returning statements; better-sqlite3 does
        // not, so execute and discard.
        stmt.all(...args);
        return { success: true as const, meta: { changes: 0, last_row_id: 0 } };
      }
      const info = stmt.run(...args);
      return {
        success: true as const,
        meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
      };
    },
    all: async <T = Row,>() => {
      const { stmt, args } = prep(sql, params);
      if (!stmt.reader) {
        const info = stmt.run(...args);
        return { results: [] as T[], success: true as const, meta: { changes: info.changes } };
      }
      return {
        results: stmt.all(...args) as T[],
        success: true as const,
        meta: { changes: 0 },
      };
    },
    raw: async <T = unknown[],>(options?: { columnNames?: boolean }) => {
      const { stmt, args } = prep(sql, params);
      if (!stmt.reader) {
        stmt.run(...args);
        return [] as T[];
      }
      const rows = stmt.raw(true).all(...args) as T[];
      if (options?.columnNames) {
        return [stmt.columns().map((c) => c.name) as T, ...rows];
      }
      return rows;
    },
  });

  const db = {
    prepare: (sql: string) => makeStatement(sql, []),
    batch: async (statements: ShimStatement[]) => {
      // D1 batches are transactional: any failure rolls the whole set back.
      // Statements execute via all() so reads keep their rows and writes
      // their change counts, mirroring the real D1Result shape.
      const results: unknown[] = [];
      sqlite.exec('BEGIN');
      try {
        for (const statement of statements) {
          results.push(await statement.all());
        }
        sqlite.exec('COMMIT');
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
      return results;
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => {
      throw new Error('dump() is not implemented in the test shim');
    },
    withSession: () => {
      throw new Error('withSession() is not implemented in the test shim');
    },
  };

  return db as unknown as D1Database;
}

/** Minimal org fixture; most product tables hang off orgs via FK. */
export function seedOrg(db: D1Database, orgId: string): Promise<unknown> {
  return db
    .prepare('INSERT INTO orgs (id, name, created_at) VALUES (?1, ?2, ?3)')
    .bind(orgId, `org ${orgId}`, 0)
    .run();
}

/** Better Auth "user" row (org_members.user_id FK target). Dates are ISO
 *  strings, matching what the kysely adapter writes. */
export function seedUser(db: D1Database, userId: string): Promise<unknown> {
  return db
    .prepare(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
    .bind(userId, `user ${userId}`, `${userId}@example.com`, '2026-07-18T10:00:00.000Z')
    .run();
}
