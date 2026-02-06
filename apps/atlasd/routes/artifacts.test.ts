import { rm } from "node:fs/promises";
import process from "node:process";
import { MAX_FILE_SIZE, MAX_PDF_SIZE } from "@atlas/core/artifacts/file-upload";
import { makeTempDir } from "@atlas/utils/temp.server";
import { black, PDF } from "@libpdf/core";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { artifactsApp } from "./artifacts.ts";

// Configure storage to use a temp directory before any imports that might use ArtifactStorage
const tempDir = makeTempDir();
process.env.ARTIFACT_STORAGE_PATH = `${tempDir}/artifacts.db`;

/** Schema for successful artifact response */
const ArtifactResponseSchema = z.object({
  artifact: z
    .object({
      id: z.string(),
      type: z.string(),
      title: z.string(),
      data: z.object({ type: z.string() }).passthrough(),
      chatId: z.string().optional(),
    })
    .passthrough(),
});

/** Schema for file artifact responses (PDF, JSON, TXT, etc.) */
const FileArtifactResponseSchema = z.object({
  artifact: z
    .object({
      id: z.string(),
      type: z.string(),
      title: z.string(),
      data: z.object({
        type: z.literal("file"),
        data: z.object({
          path: z.string(),
          mimeType: z.string().optional(),
          originalName: z.string().optional(),
        }),
      }),
      chatId: z.string().optional(),
    })
    .passthrough(),
});

/** Schema for GET artifact response with contents */
const ArtifactWithContentsSchema = z.object({
  artifact: z.object({}).passthrough(),
  contents: z.string().optional(),
});

/** Schema for batch-get response */
const BatchGetResponseSchema = z.object({
  artifacts: z.array(
    z
      .object({
        id: z.string(),
        type: z.string(),
        title: z.string(),
        data: z.object({ type: z.string() }).passthrough(),
        contents: z.string().optional(),
      })
      .passthrough(),
  ),
});

/**
 * Assert error response shape matches expected error string.
 */
const assertErrorResponse = (body: unknown, expectedError: string) => {
  expect(body).toBeDefined();
  expect(body).toMatchObject({ error: expectedError });
};

/**
 * Create a File object with specified content for testing.
 */
function createTestFile(content: string | ArrayBuffer, name: string, type: string): File {
  return new File([content], name, { type });
}

/**
 * Create a large buffer for size testing.
 */
function createLargeBuffer(size: number): ArrayBuffer {
  return new ArrayBuffer(size);
}

describe("Upload endpoint", () => {
  // Multipart parsing tests
  it("rejects non-multipart requests", async () => {
    const response = await artifactsApp.request("/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "not a file" }),
    });

    expect(response.status).toEqual(400);
    const body = await response.json();
    assertErrorResponse(body, "Content-Type must be multipart/form-data");
  });

  it("rejects requests without file field", async () => {
    const formData = new FormData();
    formData.set("chatId", "test-chat");

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(400);
    const body = await response.json();
    assertErrorResponse(body, "file field is required and must be a File");
  });

  // Size validation tests
  it("rejects files over size limit", { timeout: 30_000 }, async () => {
    const largeContent = createLargeBuffer(MAX_FILE_SIZE + 1);
    const largeFile = createTestFile(largeContent, "large.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", largeFile);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(413);
    const body = await response.json();
    const maxSizeMB = Math.round(MAX_FILE_SIZE / (1024 * 1024));
    assertErrorResponse(body, `File too large (max ${maxSizeMB}MB)`);
  });

  it("accepts files at size limit", { timeout: 30_000 }, async () => {
    const exactContent = createLargeBuffer(MAX_FILE_SIZE);
    const exactFile = createTestFile(exactContent, "exact.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", exactFile);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());
    expect(body.artifact).toBeDefined();
  });

  // MIME type validation tests
  it("accepts allowed MIME types (non-CSV)", async () => {
    const testCases = [
      { name: "test.json", type: "application/json", content: "{}" },
      { name: "test.txt", type: "text/plain", content: "hello" },
      { name: "test.md", type: "text/markdown", content: "# Title" },
    ];

    for (const { name, type, content } of testCases) {
      const file = createTestFile(content, name, type);
      const formData = new FormData();
      formData.set("file", file);

      const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

      expect(response.status).toEqual(201);
      const body = ArtifactResponseSchema.parse(await response.json());
      expect(body.artifact).toBeDefined();
      expect(body.artifact.data.type).toEqual("file");
    }
  });

  it("rejects disallowed MIME types", async () => {
    const file = createTestFile("MZ...", "test.exe", "application/x-msdownload");
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(415);
    const body = await response.json();
    assertErrorResponse(body, "File type not allowed. Supported: CSV, JSON, TXT, MD, YML, PDF");
  });

  it("rejects corrupt PDFs with user-friendly error", async () => {
    // PDF magic bytes only - not a valid PDF structure
    const pdfMagicBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e]);
    const file = createTestFile(pdfMagicBytes.buffer, "test.pdf", "application/pdf");
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    // Corrupt PDF should fail conversion with user-friendly message
    expect(response.status).toEqual(500);
    const body = await response.json();
    assertErrorResponse(body, "This PDF appears to be corrupted or invalid.");
  });

  it("rejects binary files detected by magic bytes (non-PDF)", async () => {
    // ZIP magic bytes disguised with .txt extension
    // This tests that binary detection catches files even when extension passes
    const zipMagicBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const file = createTestFile(zipMagicBytes.buffer, "sneaky.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(500);
    const body = await response.json();
    assertErrorResponse(body, "Binary files not allowed. Supported: CSV, JSON, TXT, MD, YML, PDF");
  });

  it("uses extension fallback when MIME type empty", async () => {
    // Create file with empty MIME type but valid extension
    const file = createTestFile("col1,col2\nval1,val2", "test.csv", "");
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());
    expect(body.artifact).toBeDefined();
  });

  // Path sanitization tests
  it("rejects chatId with path traversal (..)", async () => {
    const file = createTestFile("content", "test.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", file);
    formData.set("chatId", "../../../etc/passwd");

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(400);
    const body = await response.json();
    assertErrorResponse(body, "Invalid chatId");
  });

  it("rejects chatId starting with /", async () => {
    const file = createTestFile("content", "test.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", file);
    formData.set("chatId", "/etc/passwd");

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(400);
    const body = await response.json();
    assertErrorResponse(body, "Invalid chatId");
  });

  // Success path tests
  it("creates file artifact for non-CSV uploads", async () => {
    const jsonContent = '{"key": "value"}';
    const file = createTestFile(jsonContent, "data.json", "application/json");
    const formData = new FormData();
    formData.set("file", file);
    formData.set("chatId", "test-chat-123");

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());

    expect(body.artifact).toBeDefined();
    expect(body.artifact.id).toBeDefined();
    expect(body.artifact.data.type).toEqual("file");
    expect(body.artifact.title).toEqual("data.json");
    expect(body.artifact.chatId).toEqual("test-chat-123");
  });

  it("converts CSV uploads to database artifacts", async () => {
    const csvContent = "column1,column2\nvalue1,value2";
    const file = createTestFile(csvContent, "data.csv", "text/csv");
    const formData = new FormData();
    formData.set("file", file);
    formData.set("chatId", "test-chat-csv");

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());

    expect(body.artifact).toBeDefined();
    expect(body.artifact.id).toBeDefined();
    expect(body.artifact.data.type).toEqual("database");
    expect(body.artifact.title).toEqual("data.csv");
    expect(body.artifact.chatId).toEqual("test-chat-csv");

    // Database artifact should have schema metadata
    const data = body.artifact.data as {
      type: string;
      data: { schema: { rowCount: number; columns: { name: string }[] } };
    };
    expect(data.data.schema.rowCount).toEqual(1);
    expect(data.data.schema.columns.length).toEqual(2);
  });

  it("detects CSV by extension when mimeType is text/plain", async () => {
    const csvContent = "name,age\nAlice,30";
    const file = createTestFile(csvContent, "people.csv", "text/plain");
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());

    expect(body.artifact.data.type).toEqual("database");
  });

  it("assigns to orphan folder when chatId not provided", async () => {
    const file = createTestFile("content", "orphan.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", file);
    // No chatId

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());

    expect(body.artifact).toBeDefined();
    expect(body.artifact.chatId).toBeUndefined();
  });
});

describe("Batch-get endpoint", () => {
  it("includes contents when includeContents=true for file artifacts", async () => {
    // Create a file artifact via upload (using JSON, not CSV - CSV becomes database artifact)
    const jsonContent = '{"name": "Alice", "age": 30}';
    const file = createTestFile(jsonContent, "people.json", "application/json");
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());

    // Batch-get with includeContents: true
    const batchResponse = await artifactsApp.request("/batch-get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [artifact.id], includeContents: true }),
    });

    expect(batchResponse.status).toEqual(200);
    const batchBody = BatchGetResponseSchema.parse(await batchResponse.json());

    expect(batchBody.artifacts.length).toEqual(1);
    // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees [0] exists
    expect(batchBody.artifacts[0]!.id).toEqual(artifact.id);
    // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees [0] exists
    expect(batchBody.artifacts[0]!.contents).toEqual(jsonContent);
  });

  it("omits contents when includeContents=false", async () => {
    // Create a file artifact via upload (using JSON, not CSV)
    const jsonContent = '{"col1": "val1", "col2": "val2"}';
    const file = createTestFile(jsonContent, "data.json", "application/json");
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());

    // Batch-get with includeContents: false (default)
    const batchResponse = await artifactsApp.request("/batch-get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [artifact.id] }),
    });

    expect(batchResponse.status).toEqual(200);
    const batchBody = BatchGetResponseSchema.parse(await batchResponse.json());

    expect(batchBody.artifacts.length).toEqual(1);
    // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees [0] exists
    expect(batchBody.artifacts[0]!.id).toEqual(artifact.id);
    // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees [0] exists
    expect(batchBody.artifacts[0]!.contents).toBeUndefined();
  });

  it("handles mixed artifact types with includeContents", async () => {
    // Create a file artifact via upload
    const txtContent = "Hello, World!";
    const file = createTestFile(txtContent, "greeting.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact: fileArtifact } = ArtifactResponseSchema.parse(await uploadResponse.json());

    // Create a non-file artifact (summary type) via the create endpoint
    const createResponse = await artifactsApp.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test Summary",
        summary: "A test summary artifact",
        data: { type: "summary", version: 1, data: "Summary content here" },
      }),
    });
    expect(createResponse.status).toEqual(200);
    const { artifact: summaryArtifact } = ArtifactResponseSchema.parse(await createResponse.json());

    // Batch-get both with includeContents: true
    const batchResponse = await artifactsApp.request("/batch-get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [fileArtifact.id, summaryArtifact.id], includeContents: true }),
    });

    expect(batchResponse.status).toEqual(200);
    const batchBody = BatchGetResponseSchema.parse(await batchResponse.json());

    expect(batchBody.artifacts.length).toEqual(2);

    // Find each artifact in the response (order not guaranteed)
    const returnedFile = batchBody.artifacts.find((a) => a.id === fileArtifact.id);
    const returnedSummary = batchBody.artifacts.find((a) => a.id === summaryArtifact.id);

    expect(returnedFile).toBeDefined();
    expect(returnedSummary).toBeDefined();

    // File artifact should have contents
    expect(returnedFile?.contents).toEqual(txtContent);

    // Summary artifact should NOT have contents (not a file type)
    expect(returnedSummary?.contents).toBeUndefined();
  });
});

describe("Get artifact endpoint", () => {
  it("returns preview for database artifacts", async () => {
    // Create a database artifact via CSV upload
    const csvContent = "name,age,city\nAlice,30,NYC\nBob,25,LA";
    const file = createTestFile(csvContent, "people.csv", "text/csv");
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());
    expect(artifact.data.type).toEqual("database");

    // Get the artifact
    const getResponse = await artifactsApp.request(`/${artifact.id}`, { method: "GET" });

    expect(getResponse.status).toEqual(200);
    const body = (await getResponse.json()) as {
      artifact: unknown;
      contents?: string;
      preview?: {
        headers: string[];
        rows: Record<string, unknown>[];
        totalRows: number;
        truncated: boolean;
      };
    };

    expect(body.artifact).toBeDefined();
    expect(body.contents).toBeUndefined(); // No contents for database artifacts
    expect(body.preview).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: assertion above guarantees preview exists
    expect(body.preview!.headers).toEqual(["name", "age", "city"]);
    // biome-ignore lint/style/noNonNullAssertion: assertion above guarantees preview exists
    expect(body.preview!.rows).toHaveLength(2);
    // biome-ignore lint/style/noNonNullAssertion: assertion above guarantees preview exists
    expect(body.preview!.totalRows).toEqual(2);
    // biome-ignore lint/style/noNonNullAssertion: assertion above guarantees preview exists
    expect(body.preview!.truncated).toEqual(false);
  });

  it("returns contents for file artifacts (unchanged behavior)", async () => {
    // Create a file artifact (JSON, not CSV)
    const jsonContent = '{"key": "value"}';
    const file = createTestFile(jsonContent, "data.json", "application/json");
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());
    expect(artifact.data.type).toEqual("file");

    // Get the artifact
    const getResponse = await artifactsApp.request(`/${artifact.id}`, { method: "GET" });

    expect(getResponse.status).toEqual(200);
    const body = (await getResponse.json()) as {
      artifact: unknown;
      contents?: string;
      preview?: unknown;
    };

    expect(body.artifact).toBeDefined();
    expect(body.contents).toEqual(jsonContent); // Contents for file artifacts
    expect(body.preview).toBeUndefined(); // No preview for file artifacts
  });

  it("returns 404 for non-existent artifact", async () => {
    const getResponse = await artifactsApp.request("/00000000-0000-0000-0000-000000000000", {
      method: "GET",
    });

    expect(getResponse.status).toEqual(404);
    const body = await getResponse.json();
    assertErrorResponse(body, "Artifact not found");
  });
});

describe("Export endpoint", () => {
  it("exports database artifact as CSV", async () => {
    // Create a database artifact via CSV upload
    const csvContent = "name,age,city\nAlice,30,NYC\nBob,25,LA";
    const file = createTestFile(csvContent, "people.csv", "text/csv");
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());
    expect(artifact.data.type).toEqual("database");

    // Export as CSV
    const exportResponse = await artifactsApp.request(`/${artifact.id}/export?format=csv`, {
      method: "GET",
    });

    expect(exportResponse.status).toEqual(200);
    expect(exportResponse.headers.get("Content-Type")).toEqual("text/csv");
    expect(exportResponse.headers.get("Content-Disposition")).toEqual(
      'attachment; filename="people.csv"',
    );

    const exportedCsv = await exportResponse.text();
    const lines = exportedCsv.trim().split("\n");
    expect(lines.length).toEqual(3); // header + 2 data rows
    expect(lines[0]).toEqual("name,age,city");
    expect(lines[1]).toEqual("Alice,30,NYC");
    expect(lines[2]).toEqual("Bob,25,LA");
  });

  it("handles CSV values with special characters", async () => {
    // Create CSV with values that need escaping
    const csvContent = 'note,value\n"contains, comma",normal\n"has ""quotes""",another';
    const file = createTestFile(csvContent, "special.csv", "text/csv");
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());

    // Export and verify special characters are properly escaped
    const exportResponse = await artifactsApp.request(`/${artifact.id}/export?format=csv`, {
      method: "GET",
    });

    expect(exportResponse.status).toEqual(200);
    const exportedCsv = await exportResponse.text();
    const lines = exportedCsv.trim().split("\n");
    expect(lines.length).toEqual(3);
    expect(lines[0]).toEqual("note,value");
    // Values with commas should be quoted, quotes should be doubled
    expect(lines[1]).toEqual('"contains, comma",normal');
    expect(lines[2]).toEqual('"has ""quotes""",another');
  });

  it("returns 404 for non-existent artifact", async () => {
    const exportResponse = await artifactsApp.request(
      "/00000000-0000-0000-0000-000000000000/export?format=csv",
      { method: "GET" },
    );

    expect(exportResponse.status).toEqual(404);
    const body = await exportResponse.json();
    assertErrorResponse(body, "Artifact not found");
  });

  it("returns 400 for non-database artifact", async () => {
    // Create a file artifact (JSON, not CSV)
    const jsonContent = '{"key": "value"}';
    const file = createTestFile(jsonContent, "data.json", "application/json");
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());
    expect(artifact.data.type).toEqual("file");

    // Try to export - should fail
    const exportResponse = await artifactsApp.request(`/${artifact.id}/export?format=csv`, {
      method: "GET",
    });

    expect(exportResponse.status).toEqual(400);
    const body = await exportResponse.json();
    assertErrorResponse(body, "Export only available for database artifacts");
  });

  it("works without format query param (defaults to csv)", async () => {
    // Create a database artifact
    const csvContent = "col1,col2\nval1,val2";
    const file = createTestFile(csvContent, "test.csv", "text/csv");
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());

    // Export without format param
    const exportResponse = await artifactsApp.request(`/${artifact.id}/export`, { method: "GET" });

    expect(exportResponse.status).toEqual(200);
    expect(exportResponse.headers.get("Content-Type")).toEqual("text/csv");
  });

  it("handles null and empty values", async () => {
    // Create CSV with empty values (will be stored as null in SQLite)
    // Note: the last row with all empty values is skipped by PapaParse (skipEmptyLines: "greedy")
    const csvContent = "a,b,c\n1,,3\n,2,";
    const file = createTestFile(csvContent, "sparse.csv", "text/csv");
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());

    const exportResponse = await artifactsApp.request(`/${artifact.id}/export?format=csv`, {
      method: "GET",
    });

    expect(exportResponse.status).toEqual(200);
    const exportedCsv = await exportResponse.text();
    const lines = exportedCsv.trim().split("\n");
    expect(lines.length).toEqual(3);
    expect(lines[0]).toEqual("a,b,c");
    // Empty values should export as empty strings
    expect(lines[1]).toEqual("1,,3");
    expect(lines[2]).toEqual(",2,");
  });
});

describe("PDF upload integration", () => {
  /**
   * Generate a valid PDF with sufficient text to pass the empty content threshold.
   * Returns ArrayBuffer for File constructor compatibility.
   */
  async function createValidPdf(text: string): Promise<ArrayBuffer> {
    const pdf = PDF.create();
    pdf.addPage({ size: "letter" });
    const page = pdf.getPage(0);
    if (!page) throw new Error("Failed to get page");

    // Pad text to ensure it passes the 15 char empty threshold
    const paddedText = text.padEnd(20, ".");

    page.drawText(paddedText, { x: 50, y: 350, size: 12, color: black });

    const bytes = await pdf.save();
    return new Uint8Array(bytes).buffer;
  }

  it("returns 201 with artifact for valid PDF upload", async () => {
    const pdfBytes = await createValidPdf("Integration test document content");
    const file = new File([pdfBytes], "report.pdf", { type: "application/pdf" });
    const formData = new FormData();
    formData.set("file", file);
    formData.set("chatId", "test-chat-pdf");

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());
    expect(body.artifact).toBeDefined();
    expect(body.artifact.id).toBeDefined();
    expect(body.artifact.chatId).toEqual("test-chat-pdf");
  });

  it("returns artifact with data.type='file' and data.data.mimeType='text/markdown'", async () => {
    const pdfBytes = await createValidPdf("Testing converted mimeType");
    const file = new File([pdfBytes], "doc.pdf", { type: "application/pdf" });
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = FileArtifactResponseSchema.parse(await response.json());

    expect(body.artifact.data.type).toEqual("file");
    expect(body.artifact.data.data.mimeType).toEqual("text/markdown");
  });

  it("preserves .pdf extension in originalName field", async () => {
    const pdfBytes = await createValidPdf("Original filename preservation test");
    const file = new File([pdfBytes], "quarterly-report.pdf", { type: "application/pdf" });
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = FileArtifactResponseSchema.parse(await response.json());

    expect(body.artifact.data.data.originalName).toEqual("quarterly-report.pdf");
  });

  it("includes extracted text in artifact contents", async () => {
    const testText = "Unique searchable content in the PDF document";
    const pdfBytes = await createValidPdf(testText);
    const file = new File([pdfBytes], "searchable.pdf", { type: "application/pdf" });
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });

    expect(uploadResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());

    // Fetch artifact with contents
    const getResponse = await artifactsApp.request(`/${artifact.id}`, { method: "GET" });
    expect(getResponse.status).toEqual(200);

    const body = ArtifactWithContentsSchema.parse(await getResponse.json());

    const contents = body.contents;
    expect(contents).toBeDefined();
    expect(contents).toContain("# searchable.pdf");
    expect(contents).toContain(testText);
  });

  it("rejects PDFs over 50MB size limit with 413", { timeout: 30_000 }, async () => {
    // Create a buffer just over the PDF size limit
    const largeContent = createLargeBuffer(MAX_PDF_SIZE + 1);
    const largePdf = new File([largeContent], "huge.pdf", { type: "application/pdf" });
    const formData = new FormData();
    formData.set("file", largePdf);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(413);
    const body = await response.json();
    const maxSizeMB = Math.round(MAX_PDF_SIZE / (1024 * 1024));
    assertErrorResponse(body, `PDF too large (max ${maxSizeMB}MB)`);
  });
});

// Cleanup temp directory after all tests complete
afterAll(async () => {
  await rm(tempDir, { recursive: true });
});
