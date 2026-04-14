import type { Database } from "@db/sqlite";
import { z } from "zod";
import type { KVCorpus } from "../memory-adapter.ts";

const KVRowSchema = z.object({ value: z.string(), expires_at: z.number().nullable() });

const KVKeyRowSchema = z.object({ key: z.string() });

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS kv_entries (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  expires_at  INTEGER
);
`;

const GET_SQL = "SELECT value, expires_at FROM kv_entries WHERE key = ?";

const DELETE_SQL = "DELETE FROM kv_entries WHERE key = ?";

const UPSERT_SQL = `INSERT INTO kv_entries (key, value, expires_at)
VALUES (?, ?, ?)
ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`;

const LIST_SQL = `SELECT key FROM kv_entries
WHERE (expires_at IS NULL OR expires_at > ?) AND key LIKE ?`;

export class SqliteKVCorpus implements KVCorpus {
  private initialized = false;

  constructor(
    private db: Database,
    readonly workspaceId: string,
    readonly name: string,
  ) {}

  private ensureInit(): void {
    if (this.initialized) return;
    this.db.exec(INIT_SQL);
    this.initialized = true;
  }

  // deno-lint-ignore require-await
  async get<T = unknown>(key: string): Promise<T | undefined> {
    this.ensureInit();

    const raw = this.db.prepare(GET_SQL).get(key);
    if (!raw) return Promise.resolve(undefined);

    const row = KVRowSchema.parse(raw);

    if (row.expires_at !== null && row.expires_at < Date.now()) {
      this.db.prepare(DELETE_SQL).run(key);
      return Promise.resolve(undefined);
    }

    return Promise.resolve(JSON.parse(row.value) as T);
  }

  // deno-lint-ignore require-await
  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.ensureInit();

    const serialized = JSON.stringify(value);
    const expiresAt = ttlSeconds !== undefined ? Date.now() + ttlSeconds * 1000 : null;

    this.db.prepare(UPSERT_SQL).run(key, serialized, expiresAt);
    return Promise.resolve();
  }

  // deno-lint-ignore require-await
  async delete(key: string): Promise<void> {
    this.ensureInit();
    this.db.prepare(DELETE_SQL).run(key);
    return Promise.resolve();
  }

  // deno-lint-ignore require-await
  async list(prefix?: string): Promise<string[]> {
    this.ensureInit();

    const now = Date.now();
    const pattern = prefix !== undefined ? `${prefix}%` : "%";
    const rows = this.db.prepare(LIST_SQL).all(now, pattern);

    const keys: string[] = [];
    for (const row of rows) {
      const parsed = KVKeyRowSchema.parse(row);
      keys.push(parsed.key);
    }

    return Promise.resolve(keys);
  }

  static create(db: Database, workspaceId: string, name: string): SqliteKVCorpus {
    return new SqliteKVCorpus(db, workspaceId, name);
  }
}
