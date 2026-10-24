import { DatabaseSync } from "node:sqlite";
import { SCHEMA, type Db } from "./db.ts";

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db as unknown as Db;
}
