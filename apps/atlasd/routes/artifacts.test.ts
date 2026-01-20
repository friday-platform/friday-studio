import { rm } from "node:fs/promises";
import process from "node:process";
import { makeTempDir } from "@atlas/utils/temp.server";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { artifactsApp } from "./artifacts.ts";

// Configure storage to use a temp directory before any imports that might use ArtifactStorage
const tempDir = makeTempDir();
process.env.ARTIFACT_STORAGE_PATH = `${tempDir}/artifacts.db`;

/** Maximum file size for uploads (25MB) - must match artifacts.ts */
const MAX_FILE_SIZE = 25 * 1024 * 1024;

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
  it("rejects files over 25MB", async () => {
    const largeContent = createLargeBuffer(MAX_FILE_SIZE + 1);
    const largeFile = createTestFile(largeContent, "large.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", largeFile);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(413);
    const body = await response.json();
    assertErrorResponse(body, "File too large (max 25MB)");
  });

  it("accepts files exactly 25MB", async () => {
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
  it("accepts allowed MIME types", async () => {
    const testCases = [
      { name: "test.csv", type: "text/csv" },
      { name: "test.json", type: "application/json" },
      { name: "test.txt", type: "text/plain" },
      { name: "test.md", type: "text/markdown" },
    ];

    for (const { name, type } of testCases) {
      const file = createTestFile("content", name, type);
      const formData = new FormData();
      formData.set("file", file);

      const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

      expect(response.status).toEqual(201);
      const body = ArtifactResponseSchema.parse(await response.json());
      expect(body.artifact).toBeDefined();
    }
  });

  it("rejects disallowed MIME types", async () => {
    const file = createTestFile("MZ...", "test.exe", "application/x-msdownload");
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(415);
    const body = await response.json();
    // Magic byte detection correctly identifies this as binary, even though extension says .exe
    assertErrorResponse(body, "Binary files not allowed. Supported: CSV, JSON, TXT, MD, YML");
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
  it("creates artifact and returns it on success", async () => {
    const csvContent = "column1,column2\nvalue1,value2";
    const file = createTestFile(csvContent, "data.csv", "text/csv");
    const formData = new FormData();
    formData.set("file", file);
    formData.set("chatId", "test-chat-123");

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    expect(response.status).toEqual(201);
    const body = ArtifactResponseSchema.parse(await response.json());

    expect(body.artifact).toBeDefined();
    expect(body.artifact.id).toBeDefined();
    expect(body.artifact.data.type).toEqual("file");
    expect(body.artifact.title).toEqual("data.csv");
    expect(body.artifact.chatId).toEqual("test-chat-123");
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
    // Create a file artifact via upload
    const csvContent = "name,age\nAlice,30\nBob,25";
    const file = createTestFile(csvContent, "people.csv", "text/csv");
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
    expect(batchBody.artifacts[0]!.contents).toEqual(csvContent);
  });

  it("omits contents when includeContents=false", async () => {
    // Create a file artifact via upload
    const csvContent = "col1,col2\nval1,val2";
    const file = createTestFile(csvContent, "data.csv", "text/csv");
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
    expect(returnedFile!.contents).toEqual(txtContent);

    // Summary artifact should NOT have contents (not a file type)
    expect(returnedSummary!.contents).toBeUndefined();
  });
});

// Cleanup temp directory after all tests complete
afterAll(async () => {
  await rm(tempDir, { recursive: true });
});
