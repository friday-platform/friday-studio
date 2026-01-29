import { readFile, rm } from "node:fs/promises";
import process from "node:process";
import {
  CHUNK_SIZE,
  CHUNKED_UPLOAD_TTL_MS,
  MAX_FILE_SIZE,
} from "@atlas/core/artifacts/file-upload";
import { makeTempDir } from "@atlas/utils/temp.server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  _cleanupExpiredSessionsForTest,
  _getSessionForTest,
  _resetSessionsForTest,
  chunkedUploadApp,
  MAX_CONCURRENT_SESSIONS,
} from "./chunked-upload.ts";

// Configure storage to use a temp directory
const tempDir = makeTempDir();
process.env.ARTIFACT_STORAGE_PATH = `${tempDir}/artifacts.db`;

/** Schema for init response */
const InitResponseSchema = z.object({
  uploadId: z.string().uuid(),
  chunkSize: z.number(),
  totalChunks: z.number().int().positive(),
});

/** Schema for chunk upload response */
const ChunkResponseSchema = z.object({ received: z.number().int().nonnegative() });

/** Schema for complete response */
const CompleteResponseSchema = z.object({
  artifact: z
    .object({
      id: z.string(),
      type: z.string(),
      title: z.string(),
      data: z.object({ type: z.string() }).passthrough(),
    })
    .passthrough(),
});

/** Schema for status response */
const StatusResponseSchema = z.object({
  uploadId: z.string().uuid(),
  totalChunks: z.number().int().positive(),
  completedChunks: z.array(z.number().int().nonnegative()),
  status: z.enum(["uploading", "completing", "failed"]),
});

const assertErrorResponse = (body: unknown, expected: string) => {
  expect(body).toMatchObject({ error: expected });
};

/** Init a chunked upload, returns parsed response */
async function initUpload(opts: { fileName: string; fileSize: number; chatId?: string }) {
  const res = await chunkedUploadApp.request("/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  return res;
}

/** Upload a single chunk from a Blob slice */
function uploadChunk(uploadId: string, chunkIndex: number, data: Blob) {
  return chunkedUploadApp.request(`/${uploadId}/chunk/${chunkIndex}`, {
    method: "PUT",
    body: data,
  });
}

/** Complete an upload */
function completeUpload(uploadId: string) {
  return chunkedUploadApp.request(`/${uploadId}/complete`, { method: "POST" });
}

/** Get upload status */
function getStatus(uploadId: string) {
  return chunkedUploadApp.request(`/${uploadId}/status`, { method: "GET" });
}

// Reset sessions between tests to avoid cross-test pollution (e.g. rate limit)
beforeEach(() => {
  _resetSessionsForTest();
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Init endpoint (POST /init)", () => {
  it("returns uploadId, totalChunks, chunkSize for valid input", async () => {
    const res = await initUpload({ fileName: "data.txt", fileSize: CHUNK_SIZE * 2 + 100 });
    expect(res.status).toEqual(200);
    const body = InitResponseSchema.parse(await res.json());
    expect(body.chunkSize).toEqual(CHUNK_SIZE);
    expect(body.totalChunks).toEqual(3);
  });

  it("rejects disallowed extension (.exe) with 415", async () => {
    const res = await initUpload({ fileName: "malware.exe", fileSize: 1024 });
    expect(res.status).toEqual(415);
    const body = await res.json();
    assertErrorResponse(body, "File type not allowed. Supported: CSV, JSON, TXT, MD, YML");
  });

  it("rejects oversized file with 400", async () => {
    const res = await initUpload({ fileName: "huge.txt", fileSize: MAX_FILE_SIZE + 1 });
    expect(res.status).toEqual(400);
  });

  it("rejects path traversal in chatId with 400", async () => {
    const res = await initUpload({ fileName: "ok.txt", fileSize: 100, chatId: "../../etc" });
    expect(res.status).toEqual(400);
    const body = await res.json();
    assertErrorResponse(body, "Invalid chatId");
  });

  it("rejects chatId starting with /", async () => {
    const res = await initUpload({ fileName: "ok.txt", fileSize: 100, chatId: "/etc/passwd" });
    expect(res.status).toEqual(400);
    const body = await res.json();
    assertErrorResponse(body, "Invalid chatId");
  });
});

describe("Chunk upload (PUT /:uploadId/chunk/:chunkIndex)", () => {
  it("accepts a valid chunk", async () => {
    const initRes = await initUpload({ fileName: "test.txt", fileSize: 100 });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    const res = await uploadChunk(uploadId, 0, new Blob(["hello"]));
    expect(res.status).toEqual(200);
    const body = ChunkResponseSchema.parse(await res.json());
    expect(body.received).toEqual(0);
  });

  it("returns 404 for unknown uploadId", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await uploadChunk(fakeId, 0, new Blob(["data"]));
    expect(res.status).toEqual(404);
  });

  it("returns 400 for out-of-bounds chunk index", async () => {
    const initRes = await initUpload({ fileName: "test.txt", fileSize: 100 });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    // totalChunks = 1, so index 1 is out of bounds
    const res = await uploadChunk(uploadId, 1, new Blob(["data"]));
    expect(res.status).toEqual(400);
  });

  it("allows idempotent re-upload of same chunk", async () => {
    const initRes = await initUpload({ fileName: "test.txt", fileSize: 100 });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    const first = await uploadChunk(uploadId, 0, new Blob(["version1"]));
    expect(first.status).toEqual(200);

    const second = await uploadChunk(uploadId, 0, new Blob(["version2"]));
    expect(second.status).toEqual(200);
  });

  it("returns 400 for empty body", async () => {
    const initRes = await initUpload({ fileName: "test.txt", fileSize: 100 });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    const res = await chunkedUploadApp.request(`/${uploadId}/chunk/0`, {
      method: "PUT",
      // no body
    });
    expect(res.status).toEqual(400);
  });
});

describe("Complete (POST /:uploadId/complete)", () => {
  it("returns 404 for unknown uploadId", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await completeUpload(fakeId);
    expect(res.status).toEqual(404);
  });

  it("returns 400 when chunks are missing", async () => {
    const initRes = await initUpload({ fileName: "test.txt", fileSize: CHUNK_SIZE + 1 });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    // Upload only chunk 0, skip chunk 1
    await uploadChunk(uploadId, 0, new Blob(["a".repeat(CHUNK_SIZE)]));

    const res = await completeUpload(uploadId);
    expect(res.status).toEqual(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: expect.stringMatching(/Missing chunk 1/) });
  });

  it("creates artifact for text file", async () => {
    const content = "Hello, chunked world!";
    const fileSize = new Blob([content]).size;

    const initRes = await initUpload({ fileName: "hello.txt", fileSize });
    expect(initRes.status).toEqual(200);
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    const chunkRes = await uploadChunk(uploadId, 0, new Blob([content]));
    expect(chunkRes.status).toEqual(200);

    const completeRes = await completeUpload(uploadId);
    expect(completeRes.status).toEqual(201);
    const body = CompleteResponseSchema.parse(await completeRes.json());
    expect(body.artifact.id).toBeDefined();
    expect(body.artifact.title).toEqual("hello.txt");
    expect(body.artifact.data.type).toEqual("file");
  });

  it("creates database artifact for CSV file", async () => {
    const csv = "name,age\nAlice,30\nBob,25";
    const fileSize = new Blob([csv]).size;

    const initRes = await initUpload({ fileName: "people.csv", fileSize });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    await uploadChunk(uploadId, 0, new Blob([csv]));

    const completeRes = await completeUpload(uploadId);
    expect(completeRes.status).toEqual(201);
    const body = CompleteResponseSchema.parse(await completeRes.json());
    expect(body.artifact.data.type).toEqual("database");
    expect(body.artifact.title).toEqual("people.csv");
  });

  it("returns 404 on second complete (session cleaned up after success)", async () => {
    const content = "double complete test";
    const fileSize = new Blob([content]).size;

    const initRes = await initUpload({ fileName: "double.txt", fileSize });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());
    await uploadChunk(uploadId, 0, new Blob([content]));

    const first = await completeUpload(uploadId);
    expect(first.status).toEqual(201);

    const second = await completeUpload(uploadId);
    expect(second.status).toEqual(404);
  });
});

describe("Status (GET /:uploadId/status)", () => {
  it("returns completed chunks", async () => {
    // 3 chunks
    const fileSize = CHUNK_SIZE * 2 + 100;
    const initRes = await initUpload({ fileName: "status.txt", fileSize });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    // Upload chunks 0 and 2 only
    await uploadChunk(uploadId, 0, new Blob(["a".repeat(CHUNK_SIZE)]));
    await uploadChunk(uploadId, 2, new Blob(["c"]));

    const res = await getStatus(uploadId);
    expect(res.status).toEqual(200);
    const body = StatusResponseSchema.parse(await res.json());
    expect(body.completedChunks).toEqual([0, 2]);
    expect(body.totalChunks).toEqual(3);
    expect(body.status).toEqual("uploading");
  });

  it("returns 404 for unknown uploadId", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await getStatus(fakeId);
    expect(res.status).toEqual(404);
  });
});

describe("End-to-end", () => {
  it("handles multi-chunk text file upload", async () => {
    // Create content that spans exactly 2 chunks
    const chunkContent = "x".repeat(CHUNK_SIZE);
    const remainder = "leftover";
    const fullContent = chunkContent + remainder;
    const fileSize = new Blob([fullContent]).size;

    const initRes = await initUpload({ fileName: "multi.txt", fileSize, chatId: "e2e-chat" });
    expect(initRes.status).toEqual(200);
    const { uploadId, totalChunks } = InitResponseSchema.parse(await initRes.json());
    expect(totalChunks).toEqual(2);

    const blob = new Blob([fullContent]);
    // Upload chunk 0
    await uploadChunk(uploadId, 0, blob.slice(0, CHUNK_SIZE));
    // Upload chunk 1
    await uploadChunk(uploadId, 1, blob.slice(CHUNK_SIZE));

    const completeRes = await completeUpload(uploadId);
    expect(completeRes.status).toEqual(201);
    const body = CompleteResponseSchema.parse(await completeRes.json());
    expect(body.artifact.id).toBeDefined();
    expect(body.artifact.data.type).toEqual("file");
  });

  it("handles CSV multi-chunk upload producing database artifact", async () => {
    const csv = "col1,col2\nval1,val2\nval3,val4";
    const fileSize = new Blob([csv]).size;

    const initRes = await initUpload({ fileName: "data.csv", fileSize });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    await uploadChunk(uploadId, 0, new Blob([csv]));

    const completeRes = await completeUpload(uploadId);
    expect(completeRes.status).toEqual(201);
    const body = CompleteResponseSchema.parse(await completeRes.json());
    expect(body.artifact.data.type).toEqual("database");
  });
});

describe("Edge cases", () => {
  it("handles single-byte file (1 chunk)", async () => {
    const initRes = await initUpload({ fileName: "tiny.txt", fileSize: 1 });
    expect(initRes.status).toEqual(200);
    const { uploadId, totalChunks } = InitResponseSchema.parse(await initRes.json());
    expect(totalChunks).toEqual(1);

    await uploadChunk(uploadId, 0, new Blob(["x"]));

    const completeRes = await completeUpload(uploadId);
    expect(completeRes.status).toEqual(201);
  });

  it("handles file where last chunk is smaller", async () => {
    // File size not evenly divisible by CHUNK_SIZE
    const fileSize = CHUNK_SIZE + 42;
    const initRes = await initUpload({ fileName: "uneven.txt", fileSize });
    const { uploadId, totalChunks } = InitResponseSchema.parse(await initRes.json());
    expect(totalChunks).toEqual(2);

    const content = "a".repeat(CHUNK_SIZE) + "b".repeat(42);
    const blob = new Blob([content]);
    await uploadChunk(uploadId, 0, blob.slice(0, CHUNK_SIZE));
    await uploadChunk(uploadId, 1, blob.slice(CHUNK_SIZE));

    const completeRes = await completeUpload(uploadId);
    expect(completeRes.status).toEqual(201);
  });
});

describe("Content integrity", () => {
  it("assembled file content matches original", async () => {
    const chunkA = "a".repeat(CHUNK_SIZE);
    const chunkB = "tail-data";
    const fullContent = chunkA + chunkB;
    const fileSize = new Blob([fullContent]).size;

    const initRes = await initUpload({ fileName: "integrity.txt", fileSize });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    const blob = new Blob([fullContent]);
    await uploadChunk(uploadId, 0, blob.slice(0, CHUNK_SIZE));
    await uploadChunk(uploadId, 1, blob.slice(CHUNK_SIZE));

    const completeRes = await completeUpload(uploadId);
    expect(completeRes.status).toEqual(201);
    const body = CompleteResponseSchema.parse(await completeRes.json());

    // Read the file from disk and verify content matches
    const artifactData = body.artifact.data as { type: string; data: { path: string } };
    const ondisk = await readFile(artifactData.data.path, "utf-8");
    expect(ondisk).toEqual(fullContent);
  });
});

describe("Rate limiting", () => {
  it("returns 429 when MAX_CONCURRENT_SESSIONS exceeded", async () => {
    // Fill all session slots
    for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) {
      const res = await initUpload({ fileName: `file${i}.txt`, fileSize: 100 });
      expect(res.status).toEqual(200);
    }

    // Next one should be rejected
    const res = await initUpload({ fileName: "overflow.txt", fileSize: 100 });
    expect(res.status).toEqual(429);
    const body = await res.json();
    expect(body).toMatchObject({ error: expect.stringMatching(/Too many concurrent uploads/) });
  });
});

describe("Size mismatch", () => {
  it("returns 400 when assembled file size differs from declared", async () => {
    // Declare 200 bytes but upload only 5
    const initRes = await initUpload({ fileName: "mismatch.txt", fileSize: 200 });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    // totalChunks = ceil(200 / CHUNK_SIZE) = 1
    // Upload a chunk with only 5 bytes
    await uploadChunk(uploadId, 0, new Blob(["hello"]));

    const completeRes = await completeUpload(uploadId);
    expect(completeRes.status).toEqual(400);
    const body = await completeRes.json();
    expect(body).toMatchObject({ error: expect.stringMatching(/Size mismatch/) });
  });

  it("cleans up session after size mismatch failure", async () => {
    const initRes = await initUpload({ fileName: "fail.txt", fileSize: 200 });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    await uploadChunk(uploadId, 0, new Blob(["small"]));

    const firstComplete = await completeUpload(uploadId);
    expect(firstComplete.status).toEqual(400);

    // Session should be cleaned up after failure
    const statusRes = await getStatus(uploadId);
    expect(statusRes.status).toEqual(404);
  });
});

describe("Completing rejection (409)", () => {
  it("rejects chunk upload when session status is completing", async () => {
    const initRes = await initUpload({ fileName: "test.txt", fileSize: CHUNK_SIZE + 1 });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    // Upload chunk 0 so we can trigger complete
    await uploadChunk(uploadId, 0, new Blob(["a".repeat(CHUNK_SIZE)]));
    await uploadChunk(uploadId, 1, new Blob(["b"]));

    // Manually set status to "completing" to simulate race
    const session = _getSessionForTest(uploadId);
    expect(session).toBeDefined();
    session!.status = "completing";

    // Chunk upload should be rejected with 409
    const res = await uploadChunk(uploadId, 0, new Blob(["c"]));
    expect(res.status).toEqual(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: expect.stringMatching(/completing/) });
  });
});

describe("Artifact creation failure (500)", () => {
  it("returns 500 when file is detected as binary", async () => {
    // PNG file with enough magic bytes for file-type detection
    const pngHeader = new Uint8Array([
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
      0x52, // IHDR chunk header
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01, // 1x1 dimensions
      0x08,
      0x02,
      0x00,
      0x00,
      0x00,
      0x90,
      0x77,
      0x53, // bit depth, color type, crc start
    ]);
    const fileSize = pngHeader.byteLength;

    const initRes = await initUpload({ fileName: "sneaky.txt", fileSize });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    await uploadChunk(uploadId, 0, new Blob([pngHeader]));

    const completeRes = await completeUpload(uploadId);
    expect(completeRes.status).toEqual(500);
    const body = await completeRes.json();
    expect(body).toHaveProperty("error");
  });
});

describe("TTL expiration", () => {
  it("cleans up expired sessions", async () => {
    const initRes = await initUpload({ fileName: "expire.txt", fileSize: 100 });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    // Backdate session to exceed TTL
    const session = _getSessionForTest(uploadId);
    expect(session).toBeDefined();
    session!.createdAt = Date.now() - CHUNKED_UPLOAD_TTL_MS - 1000;

    await _cleanupExpiredSessionsForTest();

    // Session should be gone
    const statusRes = await getStatus(uploadId);
    expect(statusRes.status).toEqual(404);
  });
});

afterAll(async () => {
  await rm(tempDir, { recursive: true });
});
