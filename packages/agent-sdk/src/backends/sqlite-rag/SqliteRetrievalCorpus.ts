import { Database } from "@db/sqlite";
import { z } from "zod";
import type {
  DocBatch,
  Hit,
  IngestOpts,
  IngestResult,
  RetrievalCorpus,
  RetrievalOpts,
  RetrievalQuery,
  RetrievalStats,
} from "../../memory-adapter.ts";

export const SqliteRagConfigSchema = z.object({
  dbPath: z.string(),
  vectorDimension: z.number().int().positive().optional().default(1536),
});

export interface SqliteRagConfig {
  dbPath: string;
  vectorDimension?: number;
  embedFn?: (text: string) => Promise<number[]>;
  chunkFn?: (text: string) => string[];
}

const MetadataSchema = z.record(z.string(), z.unknown());

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS docs (
  pk          INTEGER PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,
  text        TEXT NOT NULL,
  metadata    TEXT,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  embedding   BLOB,
  created_at  TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  text,
  content='docs',
  content_rowid='pk'
);

CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, text) VALUES (new.pk, new.text);
END;

CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, text) VALUES ('delete', old.pk, old.text);
END;
`;

function embeddingToBlob(embedding: number[]): Uint8Array {
  const f32 = new Float32Array(embedding);
  return new Uint8Array(f32.buffer);
}

function blobToFloat32(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

function cosineSimilarity(a: number[], b: Float32Array): number {
  const n = a.length;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  return magA === 0 || magB === 0 ? 0 : dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

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
  private db: Database;
  private embedFn: ((text: string) => Promise<number[]>) | undefined;
  private chunkFn: ((text: string) => string[]) | undefined;

  constructor(config: SqliteRagConfig) {
    this.db = new Database(config.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec(SCHEMA_SQL);
    this.embedFn = config.embedFn;
    this.chunkFn = config.chunkFn;
  }

  async ingest(docs: DocBatch, _opts?: IngestOpts): Promise<IngestResult> {
    let ingested = 0;
    let skipped = 0;

    this.db.exec("BEGIN TRANSACTION");
    try {
      const checkStmt = this.db.prepare("SELECT 1 FROM docs WHERE id = ?");
      const insertStmt = this.db.prepare(
        "INSERT INTO docs (id, text, metadata, chunk_index, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );

      for (const doc of docs.docs) {
        const existing = checkStmt.get<Record<string, number>>(doc.id);
        if (existing) {
          skipped++;
          continue;
        }

        const chunks = this.chunkFn ? this.chunkFn(doc.text) : [doc.text];
        const metadataJson = doc.metadata ? JSON.stringify(doc.metadata) : null;
        const now = new Date().toISOString();

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i] ?? doc.text;
          const chunkId = chunks.length > 1 ? `${doc.id}#${i}` : doc.id;
          let embeddingBlob: Uint8Array | null = null;

          if (this.embedFn) {
            const vec = await this.embedFn(chunk);
            embeddingBlob = embeddingToBlob(vec);
          }

          insertStmt.run(chunkId, chunk, metadataJson, i, embeddingBlob, now);
        }
        ingested++;
      }

      checkStmt.finalize?.();
      insertStmt.finalize?.();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    return { ingested, skipped };
  }

  async query(q: RetrievalQuery, opts?: RetrievalOpts): Promise<Hit[]> {
    const topK = q.topK ?? 5;
    let candidates: Array<{ id: string; text: string; metadata: string | null; score: number }>;

    if (this.embedFn) {
      const queryVec = await this.embedFn(q.text);
      const rows = this.db
        .prepare("SELECT id, text, metadata, embedding FROM docs WHERE embedding IS NOT NULL")
        .all<{ id: string; text: string; metadata: string | null; embedding: Uint8Array }>();

      candidates = rows.map((row) => ({
        id: row.id,
        text: row.text,
        metadata: row.metadata,
        score: cosineSimilarity(queryVec, blobToFloat32(row.embedding)),
      }));
      candidates.sort((a, b) => b.score - a.score);
    } else {
      const ftsQuery = sanitizeFtsQuery(q.text);
      if (!ftsQuery) return [];

      const rawRows = this.db
        .prepare(
          `SELECT d.id, d.text, d.metadata, bm25(docs_fts) as score
           FROM docs_fts
           JOIN docs d ON docs_fts.rowid = d.pk
           WHERE docs_fts MATCH ?
           ORDER BY score
           LIMIT ?`,
        )
        .all<{ id: string; text: string; metadata: string | null; score: number }>(
          ftsQuery,
          topK * 2,
        );

      candidates = rawRows.map((c) => ({ ...c, score: -c.score }));
    }

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

  stats(): Promise<RetrievalStats> {
    const row = this.db
      .prepare("SELECT COUNT(*) as count, COALESCE(SUM(LENGTH(text)), 0) as sizeBytes FROM docs")
      .get<{ count: number; sizeBytes: number }>();
    return Promise.resolve({ count: row?.count ?? 0, sizeBytes: row?.sizeBytes ?? 0 });
  }

  reset(): Promise<void> {
    this.db.exec("DELETE FROM docs");
    return Promise.resolve();
  }

  close(): void {
    this.db.close();
  }
}
