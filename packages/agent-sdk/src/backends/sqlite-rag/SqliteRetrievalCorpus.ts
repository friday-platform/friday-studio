import type { Database } from "@db/sqlite";
import { z } from "zod";
import type {
  DocBatch,
  HistoryEntry,
  HistoryFilter,
  Hit,
  IngestOpts,
  IngestResult,
  RetrievalCorpus,
  RetrievalOpts,
  RetrievalQuery,
  RetrievalStats,
} from "../../memory-adapter.ts";
import { getChunker } from "./chunker.ts";

export const SqliteRagConfigSchema = z.object({ dbPath: z.string() });

export interface SqliteRagConfig {
  dbPath: string;
}

const MetadataSchema = z.record(z.string(), z.unknown());

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS corpus_meta (
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS chunks (
  pk           INTEGER PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  corpus       TEXT NOT NULL,
  doc_id       TEXT NOT NULL,
  chunk_index  INTEGER NOT NULL DEFAULT 0,
  text         TEXT NOT NULL,
  metadata     TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_corpus ON chunks(corpus);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(corpus, doc_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='pk'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.pk, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.pk, old.text);
END;

CREATE TABLE IF NOT EXISTS corpus_history (
  version TEXT NOT NULL,
  corpus  TEXT NOT NULL,
  at      TEXT NOT NULL,
  summary TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_corpus ON corpus_history(corpus);
CREATE INDEX IF NOT EXISTS idx_history_at ON corpus_history(at);
`;

function sanitizeFtsQuery(query: string): string | null {
  const sanitized = query
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = sanitized.split(" ").filter((w) => w.length >= 2);
  if (tokens.length === 0) return null;
  return tokens.join(" OR ");
}

export class SqliteRetrievalCorpus implements RetrievalCorpus {
  private initialized = false;

  constructor(
    private db: Database,
    readonly workspaceId: string,
    readonly name: string,
  ) {}

  private ensureInit(): void {
    if (this.initialized) return;
    this.db.exec(SCHEMA_SQL);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO corpus_meta (workspace_id, name, kind, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(this.workspaceId, this.name, "retrieval", new Date().toISOString());
    this.initialized = true;
  }

  private appendHistory(summary: string): void {
    const version = crypto.randomUUID();
    this.db
      .prepare("INSERT INTO corpus_history (version, corpus, at, summary) VALUES (?, ?, ?, ?)")
      .run(version, this.name, new Date().toISOString(), summary);
  }

  // deno-lint-ignore require-await
  async ingest(docs: DocBatch, opts?: IngestOpts): Promise<IngestResult> {
    this.ensureInit();
    const chunker = getChunker(opts);
    let ingested = 0;
    let skipped = 0;

    this.db.exec("BEGIN TRANSACTION");
    try {
      for (const doc of docs.docs) {
        const existing = this.db
          .prepare("SELECT 1 FROM chunks WHERE corpus = ? AND doc_id = ?")
          .get<Record<string, number>>(this.name, doc.id);

        if (existing) {
          skipped++;
          continue;
        }

        const textChunks = chunker(doc.text);
        const metadataJson = doc.metadata ? JSON.stringify(doc.metadata) : null;
        const now = new Date().toISOString();

        for (let i = 0; i < textChunks.length; i++) {
          const chunk = textChunks[i] ?? doc.text;
          const chunkId = textChunks.length > 1 ? `${doc.id}#${i}` : doc.id;
          this.db
            .prepare(
              "INSERT INTO chunks (id, corpus, doc_id, chunk_index, text, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run(chunkId, this.name, doc.id, i, chunk, metadataJson, now);
        }
        ingested++;
      }

      if (ingested > 0) {
        this.appendHistory(`Ingested ${ingested} docs (${skipped} skipped)`);
      }

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    return { ingested, skipped };
  }

  // deno-lint-ignore require-await
  async query(q: RetrievalQuery, opts?: RetrievalOpts): Promise<Hit[]> {
    this.ensureInit();
    const topK = q.topK ?? 5;

    const ftsQuery = sanitizeFtsQuery(q.text);
    if (!ftsQuery) return [];

    const rawRows = this.db
      .prepare(
        `SELECT c.id, c.text, c.metadata, bm25(chunks_fts) as score
         FROM chunks_fts
         JOIN chunks c ON chunks_fts.rowid = c.pk
         WHERE chunks_fts MATCH ?
         AND c.corpus = ?
         ORDER BY score
         LIMIT ?`,
      )
      .all<{ id: string; text: string; metadata: string | null; score: number }>(
        ftsQuery,
        this.name,
        topK * 2,
      );

    let candidates = rawRows.map((c) => ({ ...c, score: -c.score }));

    if (opts?.filter) {
      const filter = opts.filter;
      candidates = candidates.filter((c) => {
        if (!c.metadata) return false;
        const parsed = MetadataSchema.safeParse(JSON.parse(c.metadata));
        if (!parsed.success) return false;
        const meta = parsed.data;
        return Object.entries(filter).every(([key, value]) => meta[key] === value);
      });
    }

    return candidates.slice(0, topK).map((c) => {
      const hit: Hit = { id: c.id, text: c.text, score: c.score };
      if (c.metadata) {
        const parsed = MetadataSchema.safeParse(JSON.parse(c.metadata));
        if (parsed.success) {
          hit.metadata = parsed.data;
        }
      }
      return hit;
    });
  }

  // deno-lint-ignore require-await
  async stats(): Promise<RetrievalStats> {
    this.ensureInit();
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as count, COALESCE(SUM(LENGTH(text)), 0) as sizeBytes FROM chunks WHERE corpus = ?",
      )
      .get<{ count: number; sizeBytes: number }>(this.name);
    return { count: row?.count ?? 0, sizeBytes: row?.sizeBytes ?? 0 };
  }

  // deno-lint-ignore require-await
  async reset(): Promise<void> {
    this.ensureInit();
    this.db.prepare("DELETE FROM chunks WHERE corpus = ?").run(this.name);
    this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
    this.appendHistory("Corpus reset");
  }

  getHistory(filter?: HistoryFilter): HistoryEntry[] {
    this.ensureInit();
    let sql = "SELECT version, corpus, at, summary FROM corpus_history WHERE corpus = ?";
    const params: (string | number)[] = [this.name];

    if (filter?.since) {
      sql += " AND at > ?";
      params.push(filter.since);
    }

    sql += " ORDER BY rowid DESC";

    if (filter?.limit) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }

    return this.db.prepare(sql).all<HistoryEntry>(...params);
  }

  static create(db: Database, workspaceId: string, name: string): SqliteRetrievalCorpus {
    return new SqliteRetrievalCorpus(db, workspaceId, name);
  }
}
