/**
 * Artifact Converters
 *
 * Stream-based converters for transforming uploaded files to optimized storage formats.
 */

export type { ConversionResult } from "./csv-to-sqlite.ts";
// Original JS implementation (for testing or when CLI tools unavailable)
export { convertCsvToSqlite as convertCsvToSqliteJs } from "./csv-to-sqlite.ts";
// DuckDB-based converter: auto-detects DuckDB > SQLite CLI > JS fallback (2.5-4.8x faster)
export { convertCsvToSqliteFast as convertCsvToSqlite } from "./csv-to-sqlite-duckdb.ts";
// DOCX to markdown converter using jszip + xmldom
export { docxToMarkdown } from "./docx-to-markdown.ts";
// PDF to markdown converter using libpdf for text extraction
export { pdfToMarkdown } from "./pdf-to-markdown.ts";
// PPTX to markdown converter using jszip + xmldom
export { pptxToMarkdown } from "./pptx-to-markdown.ts";
// Shared converter error types
export { ConverterError, USER_FACING_ERROR_CODES } from "./xml-utils.ts";
