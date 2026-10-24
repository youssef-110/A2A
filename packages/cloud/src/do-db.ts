import type { Db, SqlValue } from "@a2a/server/core";

/** The relay's Db interface over a Durable Object's SQLite storage. Both are synchronous. */
export function doDb(storage: DurableObjectStorage): Db {
  const sql = storage.sql;
  const scalar = (query: string): number => Number((sql.exec(query).toArray()[0] as Record<string, unknown> | undefined)?.n ?? 0);
  return {
    prepare(query: string) {
      return {
        get: (...args: SqlValue[]) => sql.exec(query, ...args).toArray()[0],
        all: (...args: SqlValue[]) => sql.exec(query, ...args).toArray(),
        run: (...args: SqlValue[]) => {
          sql.exec(query, ...args).toArray();
          return { changes: scalar("SELECT changes() AS n"), lastInsertRowid: scalar("SELECT last_insert_rowid() AS n") };
        },
      };
    },
    exec(query: string) {
      sql.exec(query);
    },
    transaction<T>(fn: () => T): T {
      return storage.transactionSync(fn);
    },
  };
}
