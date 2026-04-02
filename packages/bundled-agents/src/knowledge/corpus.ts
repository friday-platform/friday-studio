/**
 * Corpus Builder: ingest CSV/TXT files → SQLite with FTS5 + vector embeddings.
 * Auto-detects CSV column structure — works with any CSV schema.
 *
 * CLI:
 *   deno run -A corpus.ts --input /path/to/data/dir --output /tmp/corpus.db
 *   deno run -A corpus.ts --input /path/to/file.csv --output /tmp/corpus.db
 */
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { createLogger } from "@atlas/logger";
import { Database } from "@db/sqlite";
import { embedBatch, embeddingToBlob } from "./embed.ts";

const log = createLogger({ name: "knowledge:corpus" });

export interface CorpusBuildOptions {
  inputPath: string;
  outputPath: string;
  onProgress?: (phase: string, done: number, total: number) => void;
}

export interface CorpusBuildResult {
  documentCount: number;
  embeddedCount: number;
  durationMs: number;
  outputPath: string;
  sources: Array<{ file: string; type: string; count: number }>;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  response TEXT,
  url TEXT,
  metadata TEXT,
  embedding BLOB
);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, content, response,
  content='documents', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, content, response)
  VALUES (new.id, new.title, new.content, COALESCE(new.response, ''));
END;

CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, content, response)
  VALUES ('delete', old.id, old.title, old.content, COALESCE(old.response, ''));
END;
`;

// ── Column auto-detection ──────────────────────────────────────────

export interface ColumnMapping {
  title: string | null;
  content: string | null;
  response: string | null;
  url: string | null;
  sourceType: string;
  idColumn: string | null;
  categoryColumn: string | null;
}

// Column detection via keyword lookup. Each role maps to a list of keywords
// that are checked against normalized header names (lowercased, whitespace
// collapsed). First match wins, order = priority.
const COLUMN_KEYWORDS: Record<string, string[]> = {
  title: ["ticket name", "article title", "title", "subject", "name", "heading", "question"],
  content: [
    "ticket description",
    "article body",
    "content",
    "body",
    "description",
    "text",
    "message",
    "details",
  ],
  response: ["response", "answer", "resolution", "reply", "closed won summary", "solution"],
  url: ["article url", "url", "link", "source url", "href"],
  id: ["ticket id", "id", "article id", "record id"],
  category: [
    "category",
    "ticket category",
    "subcategory",
    "t1 ticket type",
    "type",
    "knowledge base name",
  ],
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

function matchColumn(headers: string[], keywords: string[]): string | null {
  for (const keyword of keywords) {
    const match = headers.find((h) => normalizeHeader(h) === keyword);
    if (match) return match;
  }
  return null;
}

export function detectColumns(headers: string[]): ColumnMapping {
  const title = matchColumn(headers, COLUMN_KEYWORDS.title ?? []);
  const content = matchColumn(headers, COLUMN_KEYWORDS.content ?? []);
  const response = matchColumn(headers, COLUMN_KEYWORDS.response ?? []);
  const url = matchColumn(headers, COLUMN_KEYWORDS.url ?? []);
  const idColumn = matchColumn(headers, COLUMN_KEYWORDS.id ?? []);
  const categoryColumn = matchColumn(headers, COLUMN_KEYWORDS.category ?? []);

  // Guess source type from header names
  const normalized = headers.map(normalizeHeader);
  let sourceType = "document";
  if (normalized.some((h) => h.includes("ticket"))) sourceType = "ticket";
  else if (normalized.some((h) => h.includes("article"))) sourceType = "knowledge_base";
  else if (normalized.some((h) => h.includes("confluence"))) sourceType = "confluence";

  return { title, content, response, url, sourceType, idColumn, categoryColumn };
}

// ── CSV ingestion ──────────────────────────────────────────────────

export function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function ingestCsvFile(
  filePath: string,
  db: Database,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const fileName = path.basename(filePath);

  // Stream line-by-line instead of loading entire file into memory.
  // messages.csv alone is 221 MB — readFileSync would spike heap by ~443 MB.
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let headers: string[] | undefined;
  let mapping: ColumnMapping | undefined;
  let titleIdx = -1;
  let contentIdx = -1;
  let responseIdx = -1;
  let urlIdx = -1;
  let idIdx = -1;
  let categoryIdx = -1;

  const stmt = db.prepare(
    "INSERT INTO documents (source_type, title, content, response, url, metadata) VALUES (?, ?, ?, ?, ?, ?)",
  );

  let inserted = 0;
  let buffer = "";
  let lineNum = 0;

  // Estimate total rows from file size for progress reporting (streaming
  // doesn't know total upfront). Use 150 bytes/row as a rough average.
  const estimatedTotal = Math.round(statSync(filePath).size / 150);

  db.exec("BEGIN TRANSACTION");

  try {
    for await (const line of rl) {
      lineNum++;

      // First line is the header row
      if (!headers) {
        headers = parseCsvRow(line);
        mapping = detectColumns(headers);

        if (!mapping.title && !mapping.content) {
          return 0;
        }

        titleIdx = mapping.title ? headers.indexOf(mapping.title) : -1;
        contentIdx = mapping.content ? headers.indexOf(mapping.content) : -1;
        responseIdx = mapping.response ? headers.indexOf(mapping.response) : -1;
        urlIdx = mapping.url ? headers.indexOf(mapping.url) : -1;
        idIdx = mapping.idColumn ? headers.indexOf(mapping.idColumn) : -1;
        categoryIdx = mapping.categoryColumn ? headers.indexOf(mapping.categoryColumn) : -1;
        continue;
      }

      // Handle multi-line CSV fields (quoted fields with newlines)
      buffer += (buffer ? "\n" : "") + line;
      const quoteCount = (buffer.match(/"/g) ?? []).length;
      if (quoteCount % 2 !== 0) continue; // incomplete row

      const fields = parseCsvRow(buffer);
      buffer = "";

      // mapping is always set after header parsing (we return 0 if unmappable),
      // but TypeScript can't narrow across the for-await boundary.
      if (!mapping) continue;

      const title = (titleIdx >= 0 ? fields[titleIdx] : "")?.trim() ?? "";
      const bodyRaw = (contentIdx >= 0 ? fields[contentIdx] : "")?.trim() ?? "";
      const body = stripHtml(bodyRaw);
      const response = responseIdx >= 0 ? stripHtml(fields[responseIdx] ?? "") : null;
      const url = urlIdx >= 0 ? (fields[urlIdx] ?? "").trim() : null;
      const ticketId = idIdx >= 0 ? (fields[idIdx] ?? "").trim() : null;
      const category = categoryIdx >= 0 ? (fields[categoryIdx] ?? "").trim() : null;

      // Skip rows with no useful content
      if (title.length < 3 && body.length < 10) continue;

      // Skip header row duplicates
      if (title === mapping.title || body === mapping.content) continue;

      const displayTitle = title || `${mapping.sourceType} #${ticketId ?? lineNum}`;
      const metadata = JSON.stringify({ source_file: fileName, ticket_id: ticketId, category });

      stmt.run(mapping.sourceType, displayTitle, body, response || null, url || null, metadata);
      inserted++;

      if (inserted % 5000 === 0) {
        onProgress?.(inserted, estimatedTotal);
      }
    }
  } finally {
    stmt.finalize?.();
    db.exec(inserted > 0 ? "COMMIT" : "ROLLBACK");
  }

  return inserted;
}

// ── Text/PDF ingestion ─────────────────────────────────────────────

function ingestTextFile(filePath: string, db: Database): number {
  const content = readFileSync(filePath, "utf-8");
  const fileName = path.basename(filePath);
  const chunks: Array<{ title: string; content: string }> = [];

  // Split on double newlines or centered headings
  const paragraphs = content.split(/\n{2,}/);
  let currentTitle = fileName;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed.length < 10) continue;

    // If short and looks like a heading, use as title for next chunk
    if (trimmed.length < 100 && !trimmed.includes(".")) {
      currentTitle = trimmed;
      continue;
    }

    chunks.push({ title: currentTitle, content: trimmed });
  }

  if (chunks.length === 0) return 0;

  db.exec("BEGIN TRANSACTION");
  const stmt = db.prepare(
    "INSERT INTO documents (source_type, title, content, url, metadata) VALUES (?, ?, ?, ?, ?)",
  );
  for (const chunk of chunks) {
    stmt.run("text", chunk.title, chunk.content, null, JSON.stringify({ source_file: fileName }));
  }
  stmt.finalize?.();
  db.exec("COMMIT");
  return chunks.length;
}

// ── Embedding ──────────────────────────────────────────────────────

async function embedDocuments(
  db: Database,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const total =
    db.prepare("SELECT count(*) as c FROM documents WHERE embedding IS NULL").get<{ c: number }>()
      ?.c ?? 0;

  if (total === 0) return 0;

  // Process in chunks to avoid loading all rows + texts + embeddings into
  // memory at once. With 151K docs the old approach peaked at ~1.5 GB heap:
  //   .all() loaded 151K rows (+376 MB), .map() created texts (+214 MB),
  //   embedBatch accumulated all embeddings (+896 MB).
  // Chunking at 2000 rows caps each iteration at ~30 MB.
  const EMBED_CHUNK_SIZE = 2000;
  const MAX_EMBED_CHARS = 2000;
  let completed = 0;

  // Each iteration: LIMIT grabs the next chunk of un-embedded rows (rows we
  // just embedded no longer match WHERE embedding IS NULL).
  const selectStmt = db.prepare(
    "SELECT id, title, content FROM documents WHERE embedding IS NULL LIMIT ?",
  );
  const updateStmt = db.prepare("UPDATE documents SET embedding = ? WHERE id = ?");

  try {
    while (completed < total) {
      const rows = selectStmt.all<{ id: number; title: string; content: string }>(EMBED_CHUNK_SIZE);
      if (rows.length === 0) break;

      const texts = rows.map((r) => `${r.title}\n${r.content}`.slice(0, MAX_EMBED_CHARS));
      const embeddings = await embedBatch(texts, (done) => onProgress?.(completed + done, total));

      db.exec("BEGIN TRANSACTION");
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const emb = embeddings[i];
        if (row && emb) {
          updateStmt.run(embeddingToBlob(emb), row.id);
        }
      }
      db.exec("COMMIT");

      completed += rows.length;
      onProgress?.(completed, total);
    }
  } finally {
    selectStmt.finalize?.();
    updateStmt.finalize?.();
  }

  return completed;
}

// ── Public API ─────────────────────────────────────────────────────

export async function buildCorpus(options: CorpusBuildOptions): Promise<CorpusBuildResult> {
  const start = performance.now();
  const outputPath = path.resolve(options.outputPath);
  const sources: Array<{ file: string; type: string; count: number }> = [];

  // Validate input BEFORE deleting the existing corpus — prevents data loss
  // if the input path is wrong.
  const inputPath = path.resolve(options.inputPath);
  const inputStat = statSync(inputPath);

  try {
    await unlink(outputPath);
  } catch {
    // doesn't exist
  }

  const db = new Database(outputPath);
  try {
    db.exec(SCHEMA_SQL);
    const files: string[] = [];

    if (inputStat.isDirectory()) {
      for (const entry of readdirSync(inputPath)) {
        const ext = path.extname(entry).toLowerCase();
        if ([".csv", ".txt", ".md"].includes(ext)) {
          files.push(path.join(inputPath, entry));
        }
      }
    } else {
      files.push(inputPath);
    }

    // Ingest each file
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      const fileName = path.basename(file);
      options.onProgress?.(`Ingesting ${fileName}`, 0, 1);

      let count = 0;
      if (ext === ".csv") {
        count = await ingestCsvFile(file, db, (done, total) =>
          options.onProgress?.(`Ingesting ${fileName}`, done, total),
        );
      } else {
        count = ingestTextFile(file, db);
      }

      sources.push({ file: fileName, type: ext === ".csv" ? "csv" : "text", count });
      options.onProgress?.(`Ingested ${fileName}`, count, count);
    }

    const totalDocs =
      db.prepare("SELECT count(*) as c FROM documents").get<{ c: number }>()?.c ?? 0;

    // Embed all documents
    options.onProgress?.("Embedding", 0, totalDocs);
    const embeddedCount = await embedDocuments(db, (done, total) =>
      options.onProgress?.("Embedding", done, total),
    );

    return {
      documentCount: totalDocs,
      embeddedCount,
      durationMs: Math.round(performance.now() - start),
      outputPath,
      sources,
    };
  } finally {
    db.close();
  }
}

// ── CLI ────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf("--input");
  const outputIdx = args.indexOf("--output");

  if (inputIdx === -1 || outputIdx === -1) {
    log.error("Usage: deno run -A corpus.ts --input <dir-or-file> --output <corpus.db>");
    process.exit(1);
  }

  const inputPath = args[inputIdx + 1];
  const outputPath = args[outputIdx + 1];

  if (!inputPath || !outputPath) {
    log.error("Usage: deno run -A corpus.ts --input <dir-or-file> --output <corpus.db>");
    process.exit(1);
  }

  log.info("Starting corpus build", { inputPath, outputPath });

  const result = await buildCorpus({
    inputPath,
    outputPath,
    onProgress: (phase, done, total) => {
      if (total > 1 && done % 1000 === 0) {
        log.info(`${phase}: ${done}/${total}`);
      } else if (total <= 1) {
        log.info(phase);
      }
    },
  });

  log.info("Corpus built", {
    documents: result.documentCount,
    embedded: result.embeddedCount,
    durationMs: result.durationMs,
    sources: result.sources,
  });
}
