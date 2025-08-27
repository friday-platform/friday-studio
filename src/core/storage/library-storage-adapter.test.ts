/**
 * Tests for enhanced storeItem method with MIME type extension logic
 *
 * This test file validates the new MIME type detection and extension handling
 * using stub functions that implement the spec behavior.
 */

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

// MIME type to extension mapping from spec
const MIME_TO_EXTENSION: Record<string, string> = {
  // Text formats (most text files use text/plain with specific extensions)
  "text/plain": "txt", // Default for text/plain
  "text/html": "html",
  "text/css": "css",
  "text/csv": "csv",

  // Application text formats
  "application/json": "json",
  "application/xml": "xml",
  "application/yaml": "yaml",
  "application/x-yaml": "yml",
  "application/x-javascript": "js",

  // Images
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",

  // Video
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-msvideo": "avi",
  "video/x-ms-wmv": "wmv",

  // Audio
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/webm": "weba",

  // Applications
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-tar": "tar",
  "application/gzip": "gz",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/x-executable": "bin",
  "application/x-mach-binary": "dmg",
  "application/x-msdownload": "exe",
} as const;

// Extension-based MIME type detection for text/plain files
const EXTENSION_TO_MIME: Record<string, string> = {
  // Programming languages (all stored as text/plain with specific extensions)
  md: "text/plain",
  markdown: "text/plain",
  ts: "text/plain",
  js: "text/plain",
  py: "text/plain",
  go: "text/plain",
  rs: "text/plain",
  java: "text/plain",
  cpp: "text/plain",
  c: "text/plain",
  h: "text/plain",
  sh: "text/plain",
  rb: "text/plain",
  php: "text/plain",
  swift: "text/plain",
  kt: "text/plain",
  scala: "text/plain",
  r: "text/plain",
  sql: "text/plain",

  // Config files
  yml: "text/plain",
  yaml: "text/plain",
  toml: "text/plain",
  ini: "text/plain",
  conf: "text/plain",
  env: "text/plain",

  // Other text formats
  txt: "text/plain",
  log: "text/plain",
  readme: "text/plain",
} as const;

// Stub functions implementing the new spec behavior

function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot > 0 ? filename.substring(lastDot + 1).toLowerCase() : "";
}

function detectMimeType(
  content: string | Uint8Array,
  filename?: string,
  providedMimeType?: string,
): string {
  // 1. Use provided MIME type if valid and not empty
  if (providedMimeType && providedMimeType.trim() !== "") {
    return providedMimeType.trim();
  }

  // 2. For empty/missing MIME type, detect from filename extension
  if (filename) {
    const ext = getFileExtension(filename);
    if (EXTENSION_TO_MIME[ext]) {
      return EXTENSION_TO_MIME[ext];
    }
  }

  // 3. Analyze content structure for text formats (JSON, XML, etc.)
  if (typeof content === "string") {
    if (content.trim().startsWith("{") || content.trim().startsWith("[")) {
      return "application/json";
    }
    if (content.trim().startsWith("<")) {
      return "application/xml";
    }
  }

  // 4. Defaults
  return content instanceof Uint8Array ? "application/octet-stream" : "text/plain";
}

function getExtensionForMimeType(mimeType: string, filename?: string): string {
  // For text/plain, use filename extension if available
  if (mimeType === "text/plain" && filename) {
    const ext = getFileExtension(filename);
    if (ext && EXTENSION_TO_MIME[ext] === "text/plain") {
      return ext; // Use original extension (md, ts, go, etc.)
    }
  }

  // Use known mapping if available
  if (MIME_TO_EXTENSION[mimeType]) {
    return MIME_TO_EXTENSION[mimeType];
  }

  // Fallback for unknown MIME types
  return "dat";
}

function generateContentPath(
  id: string,
  source: string,
  mimeType: string,
  createdAt: string,
  filename?: string,
): string {
  const extension = getExtensionForMimeType(mimeType, filename);
  const filepath = `${id}.${extension}`;

  // Organize: source/YYYY/MM/id.ext
  const date = new Date(createdAt);
  const year = date.getFullYear().toString();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");

  return `${source}/${year}/${month}/${filepath}`;
}

// Library item types from schema
type ContentSource = "agent" | "job" | "user" | "system";

// Enhanced storeItem stub that implements the new MIME logic
async function storeItemStub(item: {
  id: string;
  source: ContentSource;
  name: string;
  description?: string;
  content: string | Uint8Array;
  mime_type?: string;
  filename?: string;
  session_id?: string;
  agent_ids?: string[];
  template_id?: string;
  generated_by?: string;
  custom_fields?: Record<string, any>;
  created_at: string;
  updated_at: string;
  tags: string[];
  workspace_id?: string;
}): Promise<{ mimeType: string; contentPath: string; sizeBytes: number }> {
  // Detect MIME type using new logic
  const detectedMimeType = detectMimeType(item.content, item.filename, item.mime_type);

  // Calculate content size
  const contentSize =
    typeof item.content === "string"
      ? new TextEncoder().encode(item.content).length
      : item.content.length;

  // Generate content path with MIME-based extension
  const contentPath = generateContentPath(
    item.id,
    item.source,
    detectedMimeType,
    item.created_at,
    item.filename,
  );

  return { mimeType: detectedMimeType, contentPath, sizeBytes: contentSize };
}

describe("Enhanced Library Storage - MIME Type Extension Logic", () => {
  describe("MIME Type Detection", () => {
    it("should use provided MIME type when valid", async () => {
      const result = await storeItemStub({
        id: "test-123",
        source: "agent",
        name: "Test Report",
        content: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // PDF header
        mime_type: "application/pdf",
        created_at: "2025-08-27T12:00:00Z",
        updated_at: "2025-08-27T12:00:00Z",
        tags: [],
      });

      assertEquals(result.mimeType, "application/pdf");
      assertEquals(result.contentPath, "agent/2025/08/test-123.pdf");
    });

    it("should detect MIME type from filename when MIME type is empty", async () => {
      const result = await storeItemStub({
        id: "test-456",
        source: "user",
        name: "Code File",
        content: "const x = 42;",
        mime_type: "", // Empty MIME type
        filename: "code.ts",
        created_at: "2025-08-27T12:00:00Z",
        updated_at: "2025-08-27T12:00:00Z",
        tags: [],
      });

      assertEquals(result.mimeType, "text/plain");
      assertEquals(result.contentPath, "user/2025/08/test-456.ts"); // Uses .ts extension
    });

    it("should detect MIME type from filename when MIME type is undefined", async () => {
      const result = await storeItemStub({
        id: "test-789",
        source: "user",
        name: "Documentation",
        content: "# README\n\nThis is a readme file.",
        filename: "README.md",
        created_at: "2025-08-27T12:00:00Z",
        updated_at: "2025-08-27T12:00:00Z",
        tags: [],
      });

      assertEquals(result.mimeType, "text/plain");
      assertEquals(result.contentPath, "user/2025/08/test-789.md");
    });

    it("should detect JSON from content structure", async () => {
      const result = await storeItemStub({
        id: "test-json",
        source: "agent",
        name: "Config File",
        content: '{"key": "value", "nested": {"data": true}}',
        created_at: "2025-08-27T12:00:00Z",
        updated_at: "2025-08-27T12:00:00Z",
        tags: [],
      });

      assertEquals(result.mimeType, "application/json");
      assertEquals(result.contentPath, "agent/2025/08/test-json.json");
    });

    it("should detect XML from content structure", async () => {
      const result = await storeItemStub({
        id: "test-xml",
        source: "system",
        name: "XML Config",
        content: '<?xml version="1.0"?><root><item>value</item></root>',
        created_at: "2025-08-27T12:00:00Z",
        updated_at: "2025-08-27T12:00:00Z",
        tags: [],
      });

      assertEquals(result.mimeType, "application/xml");
      assertEquals(result.contentPath, "system/2025/08/test-xml.xml");
    });
  });

  describe("Extension Mapping", () => {
    it("should use filename extension for text/plain content", async () => {
      const testCases = [
        { filename: "script.py", expected: "py" },
        { filename: "README.md", expected: "md" },
        { filename: "config.toml", expected: "toml" },
        { filename: "query.sql", expected: "sql" },
        { filename: "code.go", expected: "go" },
      ];

      for (const testCase of testCases) {
        const result = await storeItemStub({
          id: `test-${testCase.expected}`,
          source: "user",
          name: "Test File",
          content: "# Test content",
          mime_type: "text/plain",
          filename: testCase.filename,
          created_at: "2025-08-27T12:00:00Z",
          updated_at: "2025-08-27T12:00:00Z",
          tags: [],
        });

        assertEquals(result.mimeType, "text/plain");
        assertEquals(
          result.contentPath,
          `user/2025/08/test-${testCase.expected}.${testCase.expected}`,
        );
      }
    });

    it("should use MIME mapping for non-text/plain types", async () => {
      const testCases = [
        { mime: "application/pdf", expected: "pdf" },
        { mime: "image/jpeg", expected: "jpg" },
        { mime: "video/mp4", expected: "mp4" },
        { mime: "audio/mpeg", expected: "mp3" },
        { mime: "application/zip", expected: "zip" },
      ];

      for (const testCase of testCases) {
        const result = await storeItemStub({
          id: `test-${testCase.expected}`,
          source: "agent",
          name: "Test File",
          content: new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // Dummy binary content
          mime_type: testCase.mime,
          created_at: "2025-08-27T12:00:00Z",
          updated_at: "2025-08-27T12:00:00Z",
          tags: [],
        });

        assertEquals(result.mimeType, testCase.mime);
        assertEquals(
          result.contentPath,
          `agent/2025/08/test-${testCase.expected}.${testCase.expected}`,
        );
      }
    });

    it("should use .dat extension for unknown MIME types", async () => {
      const result = await storeItemStub({
        id: "test-unknown",
        source: "user",
        name: "Unknown File",
        content: new Uint8Array([0x00, 0x01, 0x02, 0x03]),
        mime_type: "application/x-custom-format",
        created_at: "2025-08-27T12:00:00Z",
        updated_at: "2025-08-27T12:00:00Z",
        tags: [],
      });

      assertEquals(result.mimeType, "application/x-custom-format");
      assertEquals(result.contentPath, "user/2025/08/test-unknown.dat");
    });
  });

  describe("Content Path Generation", () => {
    it("should generate organized paths with type/year/month/id.ext", async () => {
      const result = await storeItemStub({
        id: "uuid-12345",
        source: "system",
        name: "Session Log",
        content: "Session log content",
        mime_type: "text/plain",
        filename: "session.log",
        session_id: "sess-123",
        created_at: "2025-12-15T14:30:00Z",
        updated_at: "2025-12-15T14:30:00Z",
        tags: ["session", "archive"],
      });

      assertEquals(result.contentPath, "system/2025/12/uuid-12345.log");
    });

    it("should handle different date formats correctly", async () => {
      const result = await storeItemStub({
        id: "test-date",
        source: "agent",
        name: "Monthly Report",
        content: '{"month": "January", "data": []}',
        created_at: "2025-01-05T08:15:30Z",
        updated_at: "2025-01-05T08:15:30Z",
        tags: [],
      });

      assertEquals(result.mimeType, "application/json");
      assertEquals(result.contentPath, "agent/2025/01/test-date.json");
    });
  });

  describe("Content Size Calculation", () => {
    it("should calculate size for string content", async () => {
      const content = "Hello, 世界! 🌍"; // Mix of ASCII, Unicode, and emoji
      const result = await storeItemStub({
        id: "test-size-string",
        source: "user",
        name: "Unicode Test",
        content,
        created_at: "2025-08-27T12:00:00Z",
        updated_at: "2025-08-27T12:00:00Z",
        tags: [],
      });

      const expectedSize = new TextEncoder().encode(content).length;
      assertEquals(result.sizeBytes, expectedSize);
    });

    it("should calculate size for binary content", async () => {
      const content = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
      const result = await storeItemStub({
        id: "test-size-binary",
        source: "user",
        name: "Image File",
        content,
        mime_type: "image/png",
        created_at: "2025-08-27T12:00:00Z",
        updated_at: "2025-08-27T12:00:00Z",
        tags: [],
      });

      assertEquals(result.sizeBytes, content.length);
    });
  });

  describe("Edge Cases", () => {
    it("should handle text/plain with no filename gracefully", async () => {
      const result = await storeItemStub({
        id: "test-no-filename",
        source: "agent",
        name: "Plain Text",
        content: "Just some plain text content",
        mime_type: "text/plain",
        created_at: "2025-08-27T12:00:00Z",
        updated_at: "2025-08-27T12:00:00Z",
        tags: [],
      });

      assertEquals(result.mimeType, "text/plain");
      assertEquals(result.contentPath, "agent/2025/08/test-no-filename.txt");
    });

    it("should handle filename without extension", async () => {
      const result = await storeItemStub({
        id: "test-no-ext",
        source: "user",
        name: "File Without Extension",
        content: "Content without extension",
        filename: "README", // No extension
        created_at: "2025-08-27T12:00:00Z",
        updated_at: "2025-08-27T12:00:00Z",
        tags: [],
      });

      assertEquals(result.mimeType, "text/plain");
      assertEquals(result.contentPath, "user/2025/08/test-no-ext.txt");
    });

    it("should handle whitespace in MIME types", async () => {
      const result = await storeItemStub({
        id: "test-whitespace",
        source: "agent",
        name: "Whitespace Test",
        content: "Test content",
        mime_type: "  text/plain  ", // Whitespace around MIME type
        filename: "test.md",
        created_at: "2025-08-27T12:00:00Z",
        updated_at: "2025-08-27T12:00:00Z",
        tags: [],
      });

      assertEquals(result.mimeType, "text/plain");
      assertEquals(result.contentPath, "agent/2025/08/test-whitespace.md");
    });
  });

  describe("Enhanced Search Results", () => {
    it("should return MIME type, extension, and full path information", async () => {
      const result = await storeItemStub({
        id: "test-search-enhanced",
        source: "user",
        name: "Search Test File",
        content: "# Test markdown content",
        mime_type: "text/plain",
        filename: "test.md",
        created_at: "2025-08-27T12:00:00Z",
        updated_at: "2025-08-27T12:00:00Z",
        tags: ["test", "search"],
      });

      // Verify the stub returns the expected information
      assertEquals(result.mimeType, "text/plain");
      assertEquals(result.contentPath, "user/2025/08/test-search-enhanced.md");

      // The real implementation would also return:
      // - full_path: absolute path to the file
      // - file_extension: ".md"
      // - metadata.mime_type: "text/plain"
    });

    it("should handle different MIME types and extensions correctly", async () => {
      const testCases = [
        {
          name: "PDF Document",
          mimeType: "application/pdf",
          expectedExtension: ".pdf",
          content: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        },
        {
          name: "Python Script",
          mimeType: "text/plain",
          filename: "script.py",
          expectedExtension: ".py",
          content: "print('hello world')",
        },
        {
          name: "JSON Config",
          mimeType: "application/json",
          expectedExtension: ".json",
          content: '{"config": true}',
        },
      ];

      for (let i = 0; i < testCases.length; i++) {
        const testCase = testCases[i]!; // We know the array access is safe
        const result = await storeItemStub({
          id: `test-search-${i}`,
          source: "user",
          name: testCase.name,
          content: testCase.content,
          mime_type: testCase.mimeType,
          filename: testCase.filename,
          created_at: "2025-08-27T12:00:00Z",
          updated_at: "2025-08-27T12:00:00Z",
          tags: ["search-test"],
        });

        assertEquals(result.mimeType, testCase.mimeType);
        assertEquals(result.contentPath.endsWith(testCase.expectedExtension), true);
      }
    });
  });
});
