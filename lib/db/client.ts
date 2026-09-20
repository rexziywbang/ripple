import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

const globalForDb = globalThis as unknown as { __rippleDb?: Db; __rippleSqlite?: Database.Database; __rippleDbPath?: string };

export function databasePath(): string {
  return process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "ripple.db");
}

export function openDatabase(dbPath = databasePath()): Db {
  if (globalForDb.__rippleDb && globalForDb.__rippleDbPath === dbPath) return globalForDb.__rippleDb;
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  globalForDb.__rippleDb = db;
  globalForDb.__rippleSqlite = sqlite;
  globalForDb.__rippleDbPath = dbPath;
  return db;
}

/** Fresh, uncached in-memory database for tests. */
export function openTestDatabase(): Db {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db;
}

export function getDb(): Db {
  return openDatabase();
}

export function resetDbSingleton() {
  globalForDb.__rippleSqlite?.close();
  globalForDb.__rippleDb = undefined;
  globalForDb.__rippleSqlite = undefined;
  globalForDb.__rippleDbPath = undefined;
}

export { schema };
