-- SQLite schema for the sqlite-rag RetrievalCorpus backend.
-- Reference file — the DDL is also inlined in SqliteRetrievalCorpus.ts.

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
