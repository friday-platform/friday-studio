import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  MAX_AUDIO_SIZE,
  MAX_FILE_SIZE,
  MAX_IMAGE_SIZE,
  MAX_OFFICE_SIZE,
  MAX_PDF_SIZE,
} from "@atlas/core/artifacts/file-upload";
import { ArtifactStorage } from "@atlas/core/artifacts/storage";
import { makeTempDir } from "@atlas/utils/temp.server";
import { black, PDF } from "@libpdf/core";
import JSZip from "jszip";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { artifactsApp, replaceArtifactFromFile, resolveFileType } from "./artifacts.ts";

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

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

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

async function createValidDocx(bodyXml: string): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}"><w:body>${bodyXml}</w:body></w:document>`,
  );
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new Uint8Array(bytes).buffer;
}

async function createValidPptx(slideTexts: string[]): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const overrides = slideTexts
    .map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join("\n  ");
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${overrides}
</Types>`,
  );
  const sldIdEntries = slideTexts
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
    .join("\n    ");
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="${P_NS}" xmlns:r="${R_NS}" xmlns:a="${A_NS}">
  <p:sldIdLst>${sldIdEntries}</p:sldIdLst>
</p:presentation>`,
  );
  const relEntries = slideTexts
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
    )
    .join("\n  ");
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relEntries}
</Relationships>`,
  );
  for (let i = 0; i < slideTexts.length; i++) {
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${slideTexts[i]}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`,
    );
  }
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new Uint8Array(bytes).buffer;
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
    expect(body).toHaveProperty("error");
    expect((body as { error: string }).error).toMatch(/^File type not allowed\. Supported:/);
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
    // This tests that content-based detection catches files even when extension passes
    const zipMagicBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const file = createTestFile(zipMagicBytes.buffer, "sneaky.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(500);
    const body = await response.json();
    const { error } = z.object({ error: z.string() }).parse(body);
    expect(error).toContain("not a supported format");
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
    expect(createResponse.status).toEqual(201);
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
    if (!returnedFile) throw new Error("Expected returnedFile to be defined");
    if (!returnedSummary) throw new Error("Expected returnedSummary to be defined");

    // File artifact should have contents
    expect(returnedFile.contents).toEqual(txtContent);

    // Summary artifact should NOT have contents (not a file type)
    expect(returnedSummary.contents).toBeUndefined();
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

describe("Content endpoint", () => {
  it("returns binary content with correct Content-Type for image upload", async () => {
    // Minimal valid 1x1 red PNG (67 bytes) — enough for file-type magic-byte detection
    // prettier-ignore
    const pngBytes = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52, // IHDR chunk
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01, // 1x1, 8-bit RGB
      0x08,
      0x02,
      0x00,
      0x00,
      0x00,
      0x90,
      0x77,
      0x53,
      0xde,
      0x00,
      0x00,
      0x00,
      0x0c,
      0x49,
      0x44,
      0x41, // IDAT chunk
      0x54,
      0x08,
      0xd7,
      0x63,
      0xf8,
      0xcf,
      0xc0,
      0x00,
      0x00,
      0x00,
      0x02,
      0x00,
      0x01,
      0xe2,
      0x21,
      0xbc,
      0x33,
      0x00,
      0x00,
      0x00,
      0x00,
      0x49,
      0x45,
      0x4e, // IEND chunk
      0x44,
      0xae,
      0x42,
      0x60,
      0x82,
    ]);
    const file = new File([pngBytes], "photo.png", { type: "image/png" });
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());

    const contentResponse = await artifactsApp.request(`/${artifact.id}/content`, {
      method: "GET",
    });

    expect(contentResponse.status).toEqual(200);
    expect(contentResponse.headers.get("Content-Type")).toEqual("image/png");
    expect(contentResponse.headers.get("Cache-Control")).toEqual(
      "private, max-age=31536000, immutable",
    );

    const returnedBytes = new Uint8Array(await contentResponse.arrayBuffer());
    expect(returnedBytes).toEqual(pngBytes);
  });

  it("returns 404 for non-existent artifact", async () => {
    const response = await artifactsApp.request("/00000000-0000-0000-0000-000000000000/content", {
      method: "GET",
    });

    expect(response.status).toEqual(404);
    const body = await response.json();
    assertErrorResponse(body, "Artifact not found");
  });

  it("returns 404 for non-file artifact", async () => {
    const createResponse = await artifactsApp.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Summary",
        summary: "A summary",
        data: { type: "summary", version: 1, data: "Some content" },
      }),
    });
    expect(createResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await createResponse.json());

    const contentResponse = await artifactsApp.request(`/${artifact.id}/content`, {
      method: "GET",
    });

    expect(contentResponse.status).toEqual(404);
    const body = await contentResponse.json();
    assertErrorResponse(body, "Content endpoint only supports file artifacts");
  });

  it("returns 500 with error message when readBinaryContents fails", async () => {
    // Upload a valid file to get a real artifact ID
    const file = createTestFile("binary content", "data.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());

    // Stub readBinaryContents to simulate storage failure
    const spy = vi
      .spyOn(ArtifactStorage, "readBinaryContents")
      .mockResolvedValueOnce({ ok: false, error: "Storage read failed" });

    const contentResponse = await artifactsApp.request(`/${artifact.id}/content`, {
      method: "GET",
    });

    expect(contentResponse.status).toEqual(500);
    const body = await contentResponse.json();
    assertErrorResponse(body, "Storage read failed");

    spy.mockRestore();
  });

  it("returns security headers for image content", async () => {
    // Minimal valid 1x1 PNG
    // prettier-ignore
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
      0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
      0xcf, 0xc0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const file = new File([pngBytes], "sec.png", { type: "image/png" });
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());

    const contentResponse = await artifactsApp.request(`/${artifact.id}/content`, {
      method: "GET",
    });

    expect(contentResponse.status).toEqual(200);
    expect(contentResponse.headers.get("X-Content-Type-Options")).toEqual("nosniff");
    expect(contentResponse.headers.get("Content-Disposition")).toEqual("inline");
  });

  it("returns attachment disposition for non-image content", async () => {
    const file = createTestFile('{"key":"val"}', "data.json", "application/json");
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());

    const contentResponse = await artifactsApp.request(`/${artifact.id}/content`, {
      method: "GET",
    });

    expect(contentResponse.status).toEqual(200);
    expect(contentResponse.headers.get("X-Content-Type-Options")).toEqual("nosniff");
    expect(contentResponse.headers.get("Content-Disposition")).toEqual("attachment");
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

describe("DOCX upload integration", () => {
  it("returns 201 with artifact for valid DOCX upload", async () => {
    const docxBytes = await createValidDocx(
      `<w:p><w:r><w:t>Integration test document content for DOCX upload.</w:t></w:r></w:p>`,
    );
    const file = new File([docxBytes], "report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const formData = new FormData();
    formData.set("file", file);
    formData.set("chatId", "test-chat-docx");

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());
    expect(body.artifact).toBeDefined();
    expect(body.artifact.id).toBeDefined();
    expect(body.artifact.data.type).toEqual("file");
    expect(body.artifact.chatId).toEqual("test-chat-docx");
  });

  it("includes extracted text in artifact contents", async () => {
    const docxBytes = await createValidDocx(
      `<w:p><w:r><w:t>Unique DOCX searchable content in the document body.</w:t></w:r></w:p>`,
    );
    const file = new File([docxBytes], "searchable.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());

    const getResponse = await artifactsApp.request(`/${artifact.id}`, { method: "GET" });
    expect(getResponse.status).toEqual(200);
    const body = ArtifactWithContentsSchema.parse(await getResponse.json());

    expect(body.contents).toBeDefined();
    expect(body.contents).toContain("# searchable.docx");
    expect(body.contents).toContain("Unique DOCX searchable content in the document body.");
  });

  it("rejects DOCX over 50MB size limit with 413", { timeout: 30_000 }, async () => {
    const largeContent = createLargeBuffer(MAX_OFFICE_SIZE + 1);
    const largeDocx = new File([largeContent], "huge.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const formData = new FormData();
    formData.set("file", largeDocx);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(413);
    const body = await response.json();
    const maxSizeMB = Math.round(MAX_OFFICE_SIZE / (1024 * 1024));
    assertErrorResponse(body, `DOCX too large (max ${maxSizeMB}MB)`);
  });
});

describe("PPTX upload integration", () => {
  it("returns 201 with artifact for valid PPTX upload", async () => {
    const pptxBytes = await createValidPptx(["Slide one content", "Slide two content"]);
    const file = new File([pptxBytes], "deck.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    const formData = new FormData();
    formData.set("file", file);
    formData.set("chatId", "test-chat-pptx");

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());
    expect(body.artifact).toBeDefined();
    expect(body.artifact.id).toBeDefined();
    expect(body.artifact.data.type).toEqual("file");
    expect(body.artifact.chatId).toEqual("test-chat-pptx");
  });

  it("includes extracted slide text in artifact contents", async () => {
    const pptxBytes = await createValidPptx([
      "Unique PPTX slide content here",
      "Second slide for PPTX test",
    ]);
    const file = new File([pptxBytes], "searchable.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());

    const getResponse = await artifactsApp.request(`/${artifact.id}`, { method: "GET" });
    expect(getResponse.status).toEqual(200);
    const body = ArtifactWithContentsSchema.parse(await getResponse.json());

    expect(body.contents).toBeDefined();
    expect(body.contents).toContain("# searchable.pptx");
    expect(body.contents).toContain("## Slide 1");
    expect(body.contents).toContain("Unique PPTX slide content here");
    expect(body.contents).toContain("## Slide 2");
  });

  it("rejects PPTX over 50MB size limit with 413", { timeout: 30_000 }, async () => {
    const largeContent = createLargeBuffer(MAX_OFFICE_SIZE + 1);
    const largePptx = new File([largeContent], "huge.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    const formData = new FormData();
    formData.set("file", largePptx);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(413);
    const body = await response.json();
    const maxSizeMB = Math.round(MAX_OFFICE_SIZE / (1024 * 1024));
    assertErrorResponse(body, `PPTX too large (max ${maxSizeMB}MB)`);
  });
});

describe("Legacy format rejection", () => {
  it("rejects .doc upload with 415 and helpful message", async () => {
    const file = createTestFile("fake doc content", "report.doc", "application/msword");
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(415);
    const body = await response.json();
    assertErrorResponse(body, "Legacy .doc format not supported. Save as .docx and re-upload.");
  });

  it("rejects .ppt upload with 415 and helpful message", async () => {
    const file = createTestFile("fake ppt content", "slides.ppt", "application/vnd.ms-powerpoint");
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(415);
    const body = await response.json();
    assertErrorResponse(body, "Legacy .ppt format not supported. Save as .pptx and re-upload.");
  });
});

describe("Mismatched extension rejection", () => {
  it("rejects a ZIP file with .docx extension that is not a real DOCX", async () => {
    // Build a valid ZIP that is NOT a DOCX (no word/document.xml)
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    );
    zip.file("random/data.txt", "this is not a DOCX");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const file = new File([bytes.buffer.slice(0) as ArrayBuffer], "fake.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    // Should get a user-facing error, not a 500 stacktrace
    expect(response.status).toEqual(500);
    const body = await response.json();
    expect(body).toHaveProperty("error");
    expect((body as { error: string }).error).toMatch(
      /^Detected ZIP content, which is not a supported format\. Supported:/,
    );
  });
});

describe("replaceArtifactFromFile", () => {
  it("creates a new revision with updated content", async () => {
    // Create initial artifact via upload
    const file = createTestFile("original content", "notes.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact: original } = ArtifactResponseSchema.parse(await uploadResponse.json());

    // Write replacement file to temp dir
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("@std/path");
    const replacementPath = join(tempDir, "replacement.txt");
    await writeFile(replacementPath, "replacement content", "utf-8");

    // Replace the artifact
    const result = await replaceArtifactFromFile({
      artifactId: original.id,
      filePath: replacementPath,
      fileName: "updated-notes.txt",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.artifact.id).toBe(original.id);
    expect(result.artifact.revision).toBe(2);
    expect(result.artifact.title).toBe("updated-notes.txt");
  });

  it("replaces CSV artifact with new CSV data", async () => {
    // Create initial CSV artifact
    const csvFile = createTestFile("a,b\n1,2", "data.csv", "text/csv");
    const formData = new FormData();
    formData.set("file", csvFile);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact: original } = ArtifactResponseSchema.parse(await uploadResponse.json());
    expect(original.data.type).toBe("database");

    // Write replacement CSV
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("@std/path");
    const replacementPath = join(tempDir, "replacement.csv");
    await writeFile(replacementPath, "x,y,z\n10,20,30\n40,50,60", "utf-8");

    const result = await replaceArtifactFromFile({
      artifactId: original.id,
      filePath: replacementPath,
      fileName: "updated-data.csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.artifact.id).toBe(original.id);
    expect(result.artifact.revision).toBe(2);
    expect(result.artifact.data.type).toBe("database");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Image upload tests
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal valid 1x1 PNG (67 bytes) */
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** Minimal valid JPEG (SOI + APP0/JFIF + EOI) */
const TINY_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

describe("Image upload integration", () => {
  it("creates file artifact for PNG upload", async () => {
    const file = new File([TINY_PNG.buffer], "photo.png", { type: "image/png" });
    const formData = new FormData();
    formData.set("file", file);
    formData.set("chatId", "test-chat-img");

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());
    expect(body.artifact.data.type).toEqual("file");
    expect(body.artifact.title).toEqual("photo.png");
    expect(body.artifact.chatId).toEqual("test-chat-img");
  });

  it("creates file artifact for JPEG upload", async () => {
    const file = new File([TINY_JPEG.buffer], "photo.jpg", { type: "image/jpeg" });
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());
    expect(body.artifact.data.type).toEqual("file");
    expect(body.artifact.title).toEqual("photo.jpg");
  });

  it("stores image with correct mimeType and originalName", async () => {
    const file = new File([TINY_PNG.buffer], "diagram.png", { type: "image/png" });
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = FileArtifactResponseSchema.parse(await uploadResponse.json());

    expect(artifact.data.type).toEqual("file");
    expect(artifact.data.data.mimeType).toEqual("image/png");
    expect(artifact.data.data.originalName).toEqual("diagram.png");
  });

  it("uses 'Image: {originalName}' as summary (no LLM call)", async () => {
    const file = new File([TINY_PNG.buffer], "screenshot.png", { type: "image/png" });
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const body = await uploadResponse.json();
    const parsed = ArtifactResponseSchema.parse(body);
    const summary = (parsed.artifact as { summary?: string }).summary;
    expect(summary).toEqual("Image: screenshot.png");
  });

  it("rejects image over 5MB with 413", async () => {
    const largeContent = createLargeBuffer(MAX_IMAGE_SIZE + 1);
    const file = new File([largeContent], "huge.png", { type: "image/png" });
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(413);
    const body = await response.json();
    assertErrorResponse(body, "Image files must be under 5MB.");
  });

  it("rejects unsupported image format (.bmp) with 415", async () => {
    const file = createTestFile("fake bmp content", "photo.bmp", "image/bmp");
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(415);
  });

  it("does not convert images — stored path retains original extension", async () => {
    const file = new File([TINY_PNG.buffer], "raw.png", { type: "image/png" });
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = FileArtifactResponseSchema.parse(await uploadResponse.json());

    // The stored path should have .png extension, not .md
    expect(artifact.data.data.path).toMatch(/\.png$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audio upload tests
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal valid MP3 frame header (MPEG1 Layer3, 128kbps, 44100Hz, stereo) + padding */
const TINY_MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]);

describe("Audio upload integration", () => {
  it("creates file artifact for MP3 upload", async () => {
    const file = new File([TINY_MP3.buffer], "recording.mp3", { type: "audio/mpeg" });
    const formData = new FormData();
    formData.set("file", file);
    formData.set("chatId", "test-chat-audio");

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());
    expect(body.artifact.data.type).toEqual("file");
    expect(body.artifact.title).toEqual("recording.mp3");
    expect(body.artifact.chatId).toEqual("test-chat-audio");
  });

  it("stores audio with originalName", async () => {
    const file = new File([TINY_MP3.buffer], "voice-memo.mp3", { type: "audio/mpeg" });
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const { artifact } = FileArtifactResponseSchema.parse(await uploadResponse.json());

    expect(artifact.data.type).toEqual("file");
    expect(artifact.data.data.originalName).toEqual("voice-memo.mp3");
  });

  it("uses 'Audio: {originalName}' as summary", async () => {
    const file = new File([TINY_MP3.buffer], "meeting.mp3", { type: "audio/mpeg" });
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadResponse.status).toEqual(201);
    const body = await uploadResponse.json();
    const parsed = ArtifactResponseSchema.parse(body);
    const summary = (parsed.artifact as { summary?: string }).summary;
    expect(summary).toEqual("Audio: meeting.mp3");
  });

  it("rejects audio over 25MB with 413", async () => {
    const largeContent = createLargeBuffer(MAX_AUDIO_SIZE + 1);
    const file = new File([largeContent], "huge.mp3", { type: "audio/mpeg" });
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(413);
    const body = await response.json();
    assertErrorResponse(body, "Audio files must be under 25MB.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Content-based file routing integration tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Content-based file routing", () => {
  it("routes PDF content with .docx extension to PDF converter", async () => {
    const pdfBytes = await createValidPdf("PDF content routed correctly despite docx extension");
    const file = new File([pdfBytes], "misnamed.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());
    expect(body.artifact.data.type).toEqual("file");

    // Verify the content was extracted via PDF converter (contains page markers)
    const getResponse = await artifactsApp.request(`/${body.artifact.id}`, { method: "GET" });
    expect(getResponse.status).toEqual(200);
    const detail = ArtifactWithContentsSchema.parse(await getResponse.json());
    expect(detail.contents).toContain("PDF content routed correctly");
  });

  it("routes DOCX content with .pdf extension to DOCX converter", async () => {
    const docxBytes = await createValidDocx(
      `<w:p><w:r><w:t>DOCX content routed correctly despite pdf extension</w:t></w:r></w:p>`,
    );
    const file = new File([docxBytes], "misnamed.pdf", { type: "application/pdf" });
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());
    expect(body.artifact.data.type).toEqual("file");

    const getResponse = await artifactsApp.request(`/${body.artifact.id}`, { method: "GET" });
    expect(getResponse.status).toEqual(200);
    const detail = ArtifactWithContentsSchema.parse(await getResponse.json());
    expect(detail.contents).toContain("DOCX content routed correctly");
  });

  it("routes PPTX content with .pdf extension to PPTX converter", async () => {
    const pptxBytes = await createValidPptx(["PPTX slide routed correctly despite pdf extension"]);
    const file = new File([pptxBytes], "misnamed.pdf", { type: "application/pdf" });
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());
    expect(body.artifact.data.type).toEqual("file");

    const getResponse = await artifactsApp.request(`/${body.artifact.id}`, { method: "GET" });
    expect(getResponse.status).toEqual(200);
    const detail = ArtifactWithContentsSchema.parse(await getResponse.json());
    expect(detail.contents).toContain("PPTX slide routed correctly");
  });

  it("rejects plain ZIP with .docx extension (no OOXML markers)", async () => {
    const zip = new JSZip();
    zip.file("random/stuff.txt", "not an office file");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const file = new File([new Uint8Array(bytes).buffer], "fake.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(500);
    const body = await response.json();
    const { error } = z.object({ error: z.string() }).parse(body);
    expect(error).toContain("not a supported format");
  });

  it("routes PNG content with .txt extension to image storage", async () => {
    const file = new File([TINY_PNG.buffer], "misnamed.txt", { type: "text/plain" });
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const { artifact } = FileArtifactResponseSchema.parse(await response.json());
    expect(artifact.data.type).toEqual("file");
    expect(artifact.data.data.mimeType).toEqual("image/png");
    // Persisted path should use resolved extension .png, not original .txt
    expect(artifact.data.data.path).toMatch(/\.png$/);
  });

  it("routes DOCX content with .txt extension to DOCX converter", async () => {
    const docxBytes = await createValidDocx(
      `<w:p><w:r><w:t>DOCX content routed correctly despite txt extension</w:t></w:r></w:p>`,
    );
    const file = new File([docxBytes], "misnamed.txt", { type: "text/plain" });
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());
    expect(body.artifact.data.type).toEqual("file");

    const getResponse = await artifactsApp.request(`/${body.artifact.id}`, { method: "GET" });
    expect(getResponse.status).toEqual(200);
    const detail = ArtifactWithContentsSchema.parse(await getResponse.json());
    expect(detail.contents).toContain("DOCX content routed correctly");
  });

  it("rejects XLSX content with .docx extension (no converter)", async () => {
    // Build a minimal XLSX (has xl/workbook.xml, not word/document.xml)
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
</Types>`,
    );
    zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook/>`);
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const file = new File([new Uint8Array(bytes).buffer], "data.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(500);
    const body = await response.json();
    const { error } = z.object({ error: z.string() }).parse(body);
    expect(error).toContain("not a supported format");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveFileType() unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveFileType", () => {
  it.each([
    { mime: "application/pdf", ext: "pdf", label: "PDF" },
    { mime: "image/png", ext: "png", label: "PNG" },
    { mime: "image/jpeg", ext: "jpg", label: "JPEG" },
    { mime: "image/webp", ext: "webp", label: "WebP" },
    { mime: "image/gif", ext: "gif", label: "GIF" },
    {
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ext: "docx",
      label: "OOXML DOCX",
    },
    {
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ext: "pptx",
      label: "OOXML PPTX",
    },
  ])("returns detected.mime directly for $label", async ({ mime, ext }) => {
    const result = await resolveFileType(
      { mime, ext },
      join(tempDir, "unused.bin"),
      "irrelevant.txt",
    );
    expect(result).toBe(mime);
  });

  it("returns undefined for unsupported detected MIME", async () => {
    const result = await resolveFileType(
      { mime: "application/x-msdownload", ext: "exe" },
      join(tempDir, "unused.bin"),
      "program.exe",
    );
    expect(result).toBeUndefined();
  });

  it("returns audio/mpeg for detected MP3 content", async () => {
    const result = await resolveFileType(
      { mime: "audio/mpeg", ext: "mp3" },
      join(tempDir, "unused.bin"),
      "song.mp3",
    );
    expect(result).toBe("audio/mpeg");
  });

  it("returns DOCX MIME when ZIP contains word/document.xml", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", "<document/>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const filePath = join(tempDir, "docx-peek-test.zip");
    await writeFile(filePath, bytes);

    const result = await resolveFileType(
      { mime: "application/zip", ext: "zip" },
      filePath,
      "report.docx",
    );
    expect(result).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("returns PPTX MIME when ZIP contains ppt/presentation.xml", async () => {
    const zip = new JSZip();
    zip.file("ppt/presentation.xml", "<presentation/>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const filePath = join(tempDir, "pptx-peek-test.zip");
    await writeFile(filePath, bytes);

    const result = await resolveFileType(
      { mime: "application/zip", ext: "zip" },
      filePath,
      "deck.pptx",
    );
    expect(result).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
  });

  it("returns undefined when ZIP has no OOXML markers", async () => {
    const zip = new JSZip();
    zip.file("random/data.txt", "not an office file");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const filePath = join(tempDir, "plain-zip-test.zip");
    await writeFile(filePath, bytes);

    const result = await resolveFileType(
      { mime: "application/zip", ext: "zip" },
      filePath,
      "archive.docx",
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when ZIP file is corrupt/unreadable", async () => {
    const filePath = join(tempDir, "corrupt-zip-test.zip");
    await writeFile(filePath, new Uint8Array([0x00, 0x01, 0x02, 0x03]));

    const result = await resolveFileType(
      { mime: "application/zip", ext: "zip" },
      filePath,
      "bad.docx",
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for ZIP exceeding MAX_OFFICE_SIZE without reading", async () => {
    // Write a valid DOCX (with word/document.xml) padded to exceed MAX_OFFICE_SIZE.
    // If the stat guard is removed, JSZip would find the OOXML marker and return
    // DOCX MIME — making this test fail, which proves the guard is load-bearing.
    const docxBytes = new Uint8Array(await createValidDocx("<w:p/>"));
    const oversized = new Uint8Array(MAX_OFFICE_SIZE + 1);
    oversized.set(docxBytes);
    const filePath = join(tempDir, "oversized-zip-test.zip");
    await writeFile(filePath, oversized);

    const result = await resolveFileType(
      { mime: "application/zip", ext: "zip" },
      filePath,
      "huge.docx",
    );
    expect(result).toBeUndefined();
  });

  it("falls back to extension mapping when detected is undefined (.csv)", async () => {
    const result = await resolveFileType(undefined, join(tempDir, "unused.bin"), "data.csv");
    expect(result).toBe("text/csv");
  });

  it("falls back to extension mapping when detected is undefined (.txt)", async () => {
    const result = await resolveFileType(undefined, join(tempDir, "unused.bin"), "notes.txt");
    expect(result).toBe("text/plain");
  });

  it("falls back to extension mapping when detected is undefined (.json)", async () => {
    const result = await resolveFileType(undefined, join(tempDir, "unused.bin"), "config.json");
    expect(result).toBe("application/json");
  });

  it("returns undefined when detected is undefined and extension is unknown", async () => {
    const result = await resolveFileType(undefined, join(tempDir, "unused.bin"), "file.xyz");
    expect(result).toBeUndefined();
  });
});

// Cleanup temp directory after all tests complete
afterAll(async () => {
  await rm(tempDir, { recursive: true });
});
