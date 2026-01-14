import { rm } from "node:fs/promises";
import process from "node:process";
import { makeTempDir } from "@atlas/utils/temp.server";
import { assertEquals, assertExists, assertObjectMatch } from "@std/assert";
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
  assertExists(body);
  assertObjectMatch(body as Record<string, unknown>, { error: expectedError });
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

Deno.test("Upload endpoint", async (t) => {
  // Multipart parsing tests
  await t.step("rejects non-multipart requests", async () => {
    const response = await artifactsApp.request("/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "not a file" }),
    });

    assertEquals(response.status, 400);
    const body = await response.json();
    assertErrorResponse(body, "Content-Type must be multipart/form-data");
  });

  await t.step("rejects requests without file field", async () => {
    const formData = new FormData();
    formData.set("chatId", "test-chat");

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    assertEquals(response.status, 400);
    const body = await response.json();
    assertErrorResponse(body, "file field is required and must be a File");
  });

  // Size validation tests
  await t.step("rejects files over 25MB", async () => {
    const largeContent = createLargeBuffer(MAX_FILE_SIZE + 1);
    const largeFile = createTestFile(largeContent, "large.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", largeFile);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    assertEquals(response.status, 413);
    const body = await response.json();
    assertErrorResponse(body, "File too large (max 25MB)");
  });

  await t.step("accepts files exactly 25MB", async () => {
    const exactContent = createLargeBuffer(MAX_FILE_SIZE);
    const exactFile = createTestFile(exactContent, "exact.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", exactFile);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    assertEquals(response.status, 201);
    const body = ArtifactResponseSchema.parse(await response.json());
    assertExists(body.artifact);
  });

  // MIME type validation tests
  await t.step("accepts allowed MIME types", async () => {
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

      assertEquals(response.status, 201, `Expected 201 for ${type}, got ${response.status}`);
      const body = ArtifactResponseSchema.parse(await response.json());
      assertExists(body.artifact, `Expected artifact for ${type}`);
    }
  });

  await t.step("rejects disallowed MIME types", async () => {
    const file = createTestFile("MZ...", "test.exe", "application/x-msdownload");
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    assertEquals(response.status, 415);
    const body = await response.json();
    // Magic byte detection correctly identifies this as binary, even though extension says .exe
    assertErrorResponse(body, "Binary files not allowed. Supported: CSV, JSON, TXT, MD");
  });

  await t.step("uses extension fallback when MIME type empty", async () => {
    // Create file with empty MIME type but valid extension
    const file = createTestFile("col1,col2\nval1,val2", "test.csv", "");
    const formData = new FormData();
    formData.set("file", file);

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    assertEquals(response.status, 201);
    const body = ArtifactResponseSchema.parse(await response.json());
    assertExists(body.artifact);
  });

  // Path sanitization tests
  await t.step("rejects chatId with path traversal (..)", async () => {
    const file = createTestFile("content", "test.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", file);
    formData.set("chatId", "../../../etc/passwd");

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    assertEquals(response.status, 400);
    const body = await response.json();
    assertErrorResponse(body, "Invalid chatId");
  });

  await t.step("rejects chatId starting with /", async () => {
    const file = createTestFile("content", "test.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", file);
    formData.set("chatId", "/etc/passwd");

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    assertEquals(response.status, 400);
    const body = await response.json();
    assertErrorResponse(body, "Invalid chatId");
  });

  // Success path tests
  await t.step("creates artifact and returns it on success", async () => {
    const csvContent = "column1,column2\nvalue1,value2";
    const file = createTestFile(csvContent, "data.csv", "text/csv");
    const formData = new FormData();
    formData.set("file", file);
    formData.set("chatId", "test-chat-123");

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    assertEquals(response.status, 201);
    const body = ArtifactResponseSchema.parse(await response.json());

    assertExists(body.artifact);
    assertExists(body.artifact.id);
    assertEquals(body.artifact.data.type, "file");
    assertEquals(body.artifact.title, "data.csv");
    assertEquals(body.artifact.chatId, "test-chat-123");
  });

  await t.step("assigns to orphan folder when chatId not provided", async () => {
    const file = createTestFile("content", "orphan.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", file);
    // No chatId

    const response = await artifactsApp.request("/upload", { method: "POST", body: formData });

    assertEquals(response.status, 201);
    const body = ArtifactResponseSchema.parse(await response.json());

    assertExists(body.artifact);
    assertEquals(body.artifact.chatId, undefined);
  });

  // Cleanup
  await rm(tempDir, { recursive: true });
});

Deno.test("Batch-get endpoint", async (t) => {
  await t.step("includes contents when includeContents=true for file artifacts", async () => {
    // Create a file artifact via upload
    const csvContent = "name,age\nAlice,30\nBob,25";
    const file = createTestFile(csvContent, "people.csv", "text/csv");
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    assertEquals(uploadResponse.status, 201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());

    // Batch-get with includeContents: true
    const batchResponse = await artifactsApp.request("/batch-get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [artifact.id], includeContents: true }),
    });

    assertEquals(batchResponse.status, 200);
    const batchBody = BatchGetResponseSchema.parse(await batchResponse.json());

    assertEquals(batchBody.artifacts.length, 1);
    // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees [0] exists
    assertEquals(batchBody.artifacts[0]!.id, artifact.id);
    // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees [0] exists
    assertEquals(batchBody.artifacts[0]!.contents, csvContent);
  });

  await t.step("omits contents when includeContents=false", async () => {
    // Create a file artifact via upload
    const csvContent = "col1,col2\nval1,val2";
    const file = createTestFile(csvContent, "data.csv", "text/csv");
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    assertEquals(uploadResponse.status, 201);
    const { artifact } = ArtifactResponseSchema.parse(await uploadResponse.json());

    // Batch-get with includeContents: false (default)
    const batchResponse = await artifactsApp.request("/batch-get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [artifact.id] }),
    });

    assertEquals(batchResponse.status, 200);
    const batchBody = BatchGetResponseSchema.parse(await batchResponse.json());

    assertEquals(batchBody.artifacts.length, 1);
    // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees [0] exists
    assertEquals(batchBody.artifacts[0]!.id, artifact.id);
    // biome-ignore lint/style/noNonNullAssertion: length assertion above guarantees [0] exists
    assertEquals(batchBody.artifacts[0]!.contents, undefined);
  });

  await t.step("handles mixed artifact types with includeContents", async () => {
    // Create a file artifact via upload
    const txtContent = "Hello, World!";
    const file = createTestFile(txtContent, "greeting.txt", "text/plain");
    const formData = new FormData();
    formData.set("file", file);

    const uploadResponse = await artifactsApp.request("/upload", {
      method: "POST",
      body: formData,
    });
    assertEquals(uploadResponse.status, 201);
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
    assertEquals(createResponse.status, 200);
    const { artifact: summaryArtifact } = ArtifactResponseSchema.parse(await createResponse.json());

    // Batch-get both with includeContents: true
    const batchResponse = await artifactsApp.request("/batch-get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [fileArtifact.id, summaryArtifact.id], includeContents: true }),
    });

    assertEquals(batchResponse.status, 200);
    const batchBody = BatchGetResponseSchema.parse(await batchResponse.json());

    assertEquals(batchBody.artifacts.length, 2);

    // Find each artifact in the response (order not guaranteed)
    const returnedFile = batchBody.artifacts.find((a) => a.id === fileArtifact.id);
    const returnedSummary = batchBody.artifacts.find((a) => a.id === summaryArtifact.id);

    assertExists(returnedFile);
    assertExists(returnedSummary);

    // File artifact should have contents
    assertEquals(returnedFile.contents, txtContent);

    // Summary artifact should NOT have contents (not a file type)
    assertEquals(returnedSummary.contents, undefined);
  });
});
