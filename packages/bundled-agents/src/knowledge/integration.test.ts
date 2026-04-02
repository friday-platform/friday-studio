/**
 * Integration tests for knowledge pipeline: loadEmbeddings, streaming CSV,
 * chunked embedding. Uses real SQLite and small fixture data.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "@db/sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildCorpus } from "./corpus.ts";
import { embeddingToBlob } from "./embed.ts";
import { invalidateEmbeddingCache, loadEmbeddings } from "./search.ts";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, source_type TEXT NOT NULL, title TEXT NOT NULL,
  content TEXT NOT NULL, response TEXT, url TEXT, metadata TEXT, embedding BLOB
);
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, content, response, content='documents', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, content, response)
  VALUES (new.id, new.title, new.content, COALESCE(new.response, ''));
END;
`;

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "knowledge-test-"));
}

function makeEmbedding(seed: number, dims = 4): number[] {
  return Array.from({ length: dims }, (_, i) => Math.sin(seed + i) * 0.5);
}

function mockEmbedBatch() {
  return (texts: string[], onProgress?: (done: number, total: number) => void) => {
    const result = texts.map((_, i) => makeEmbedding(i, 768));
    onProgress?.(texts.length, texts.length);
    return Promise.resolve(result);
  };
}

describe("loadEmbeddings", () => {
  let dbPath: string;

  afterEach(async () => {
    invalidateEmbeddingCache();
    try {
      await unlink(dbPath);
    } catch {
      /* noop */
    }
  });

  test("loads all embeddings and excludes rows without them", () => {
    const dir = makeTempDir();
    dbPath = path.join(dir, "test.db");
    const db = new Database(dbPath);
    db.exec(SCHEMA_SQL);

    const stmt = db.prepare(
      "INSERT INTO documents (source_type, title, content, embedding) VALUES (?, ?, ?, ?)",
    );
    for (let i = 0; i < 10; i++) {
      stmt.run("ticket", `T${i}`, `C${i}`, embeddingToBlob(makeEmbedding(i)));
    }
    stmt.finalize?.();
    // 2 rows without embeddings
    db.prepare("INSERT INTO documents (source_type, title, content) VALUES (?, ?, ?)").run(
      "ticket",
      "No emb",
      "No content",
    );
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const cache = loadEmbeddings(readDb, dbPath);
    readDb.close();

    expect(cache.ids.length).toBe(10);
    expect(cache.embeddings.length).toBe(10);
    expect(cache.embeddings[0]).toBeInstanceOf(Float32Array);
    expect(cache.embeddings[0]?.length).toBe(4);
  });
});

describe("buildCorpus", () => {
  let outputPath: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await unlink(outputPath);
    } catch {
      /* noop */
    }
  });

  test("ingests CSV via streaming and embeds all documents", async () => {
    const dir = makeTempDir();
    outputPath = path.join(dir, "corpus.db");
    const csvPath = path.join(dir, "tickets.csv");
    writeFileSync(
      csvPath,
      [
        "Ticket ID,Ticket name,Ticket description",
        '1,"Login issue","Cannot log in to the platform"',
        '2,"Password reset","Need to reset my password"',
        '3,"Gift card","My gift card is not working"',
      ].join("\n"),
    );

    const embedModule = await import("./embed.ts");
    vi.spyOn(embedModule, "embedBatch").mockImplementation(mockEmbedBatch());

    const result = await buildCorpus({ inputPath: csvPath, outputPath });

    expect(result.documentCount).toBe(3);
    expect(result.embeddedCount).toBe(3);

    const db = new Database(outputPath, { readonly: true });
    const rows = db
      .prepare("SELECT title, source_type FROM documents ORDER BY id")
      .all<{ title: string; source_type: string }>();
    db.close();

    expect(rows[0]?.title).toBe("Login issue");
    expect(rows[0]?.source_type).toBe("ticket");
  });

  test("handles multi-line CSV fields via streaming", async () => {
    const dir = makeTempDir();
    outputPath = path.join(dir, "corpus.db");
    const csvPath = path.join(dir, "multiline.csv");
    writeFileSync(
      csvPath,
      [
        "title,content",
        '"Simple row","Simple content for testing"',
        '"Multi-line","This content has\nmultiple\nlines inside quotes"',
      ].join("\n"),
    );

    const embedModule = await import("./embed.ts");
    vi.spyOn(embedModule, "embedBatch").mockImplementation(mockEmbedBatch());

    const result = await buildCorpus({ inputPath: csvPath, outputPath });
    expect(result.documentCount).toBe(2);

    const db = new Database(outputPath, { readonly: true });
    const row = db
      .prepare("SELECT content FROM documents WHERE title = 'Multi-line'")
      .get<{ content: string }>();
    db.close();

    expect(row?.content).toContain("multiple");
    expect(row?.content).toContain("lines inside quotes");
  });
});
