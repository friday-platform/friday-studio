/**
 * Artifact Converters
 *
 * Stream-based converters for transforming uploaded files to optimized storage formats.
 */

// DOCX to markdown converter using jszip + xmldom
export { docxToMarkdown } from "./docx-to-markdown.ts";
// PDF to markdown converter using libpdf for text extraction
export { pdfToMarkdown } from "./pdf-to-markdown.ts";
// PPTX to markdown converter using jszip + xmldom
export { pptxToMarkdown } from "./pptx-to-markdown.ts";
// Shared converter error types
export { ConverterError, USER_FACING_ERROR_CODES } from "./xml-utils.ts";
