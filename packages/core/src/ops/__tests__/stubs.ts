/**
 * Minimal D1/KV stubs for testing ops logic without a real database. The db
 * stub records every (sql, params) pair and lets each test decide what a
 * statement returns via the `respond` callback.
 */

export interface RecordedQuery {
  sql: string;
  params: unknown[];
}

export interface StubResult {
  /** Rows returned from .all() */
  results?: Array<Record<string, unknown>>;
  /** Row returned from .first() */
  first?: Record<string, unknown> | null;
  /** meta.changes for .run() (default 1) */
  changes?: number;
  /** Throw this instead of returning */
  error?: Error;
}

interface StubStatement {
  bind(...args: unknown[]): StubStatement;
  run(): Promise<{ success: true; meta: { changes: number } }>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[]; success: true; meta: { changes: number } }>;
}

export function createDbStub(
  respond: (query: RecordedQuery, index: number) => StubResult = () => ({}),
): { db: D1Database; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];

  const record = (sql: string, params: unknown[]): StubResult => {
    const query = { sql, params };
    const result = respond(query, queries.length);
    queries.push(query);
    if (result.error) throw result.error;
    return result;
  };

  const makeStatement = (sql: string, params: unknown[]): StubStatement => ({
    bind: (...args: unknown[]) => makeStatement(sql, args),
    run: async () => {
      const result = record(sql, params);
      return { success: true, meta: { changes: result.changes ?? 1 } };
    },
    first: async <T,>() => {
      const result = record(sql, params);
      return (result.first ?? null) as T | null;
    },
    all: async <T,>() => {
      const result = record(sql, params);
      return { results: (result.results ?? []) as T[], success: true, meta: { changes: result.changes ?? 0 } };
    },
  });

  const db = {
    prepare: (sql: string) => makeStatement(sql, []),
    batch: async (statements: StubStatement[]) => Promise.all(statements.map((s) => s.run())),
  };

  return { db: db as unknown as D1Database, queries };
}

export function createKvStub(initial: Record<string, string> = {}): {
  kv: KVNamespace;
  store: Map<string, string>;
  puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }>;
  deletes: string[];
} {
  const store = new Map(Object.entries(initial));
  const puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = [];
  const deletes: string[] = [];

  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      store.set(key, value);
      puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      store.delete(key);
      deletes.push(key);
    },
  };

  return { kv: kv as unknown as KVNamespace, store, puts, deletes };
}
