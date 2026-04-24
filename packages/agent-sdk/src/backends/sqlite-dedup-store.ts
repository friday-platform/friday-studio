import type { Database } from "@db/sqlite";
import { z } from "zod";
import type { DedupEntry, DedupStore } from "../memory-adapter.ts";

const DedupRowSchema = z.object({ value: z.string() });

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS dedup_entries (
  id          TEXT PRIMARY KEY,
  namespace   TEXT NOT NULL,
  field       TEXT NOT NULL,
  value       TEXT NOT NULL,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dedup_ns_field ON dedup_entries(namespace, field);
`;

const PRUNE_SQL = "DELETE FROM dedup_entries WHERE expires_at IS NOT NULL AND expires_at < ?";

const UPSERT_SQL = `INSERT INTO dedup_entries (id, namespace, field, value, expires_at, created_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`;

const FILTER_SQL = `SELECT value FROM dedup_entries
WHERE namespace = ? AND field = ? AND (expires_at IS NULL OR expires_at > ?)`;

const CLEAR_SQL = "DELETE FROM dedup_entries WHERE namespace = ?";

function makeId(namespace: string, field: string, value: string): string {
  return `${namespace}:${field}:${value}`;
}

export class SqliteDedupStore implements DedupStore {
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

  private prune(): void {
    this.db.prepare(PRUNE_SQL).run(Date.now());
  }

  // deno-lint-ignore require-await
  async append(namespace: string, entry: DedupEntry, ttlHours?: number): Promise<void> {
    this.ensureInit();
    this.prune();

    const now = Date.now();
    const expiresAt = ttlHours !== undefined ? now + ttlHours * 3_600_000 : null;

    for (const [field, value] of Object.entries(entry)) {
      const serialized = JSON.stringify(value);
      const id = makeId(namespace, field, serialized);
      this.db.prepare(UPSERT_SQL).run(id, namespace, field, serialized, expiresAt, now);
    }

    return Promise.resolve();
  }

  // deno-lint-ignore require-await
  async filter(namespace: string, field: string, values: unknown[]): Promise<unknown[]> {
    this.ensureInit();
    this.prune();

    const now = Date.now();
    const existing = new Set<string>();
    const rows = this.db.prepare(FILTER_SQL).all(namespace, field, now);

    for (const row of rows) {
      const parsed = DedupRowSchema.parse(row);
      existing.add(parsed.value);
    }

    const novel: unknown[] = [];
    for (const v of values) {
      const serialized = JSON.stringify(v);
      if (!existing.has(serialized)) {
        novel.push(v);
      }
    }

    return Promise.resolve(novel);
  }

  // deno-lint-ignore require-await
  async clear(namespace: string): Promise<void> {
    this.ensureInit();
    this.db.prepare(CLEAR_SQL).run(namespace);
    return Promise.resolve();
  }

  static create(db: Database, workspaceId: string, name: string): SqliteDedupStore {
    return new SqliteDedupStore(db, workspaceId, name);
  }

  static makeRowId(namespace: string, field: string, value: unknown): string {
    return makeId(namespace, field, JSON.stringify(value));
  }
}
