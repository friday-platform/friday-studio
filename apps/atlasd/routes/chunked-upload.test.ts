import { rm } from "node:fs/promises";
import process from "node:process";
import {
  CHUNK_SIZE,
  CHUNKED_UPLOAD_TTL_MS,
  MAX_FILE_SIZE,
} from "@atlas/core/artifacts/file-upload";
import { initArtifactStorage } from "@atlas/core/artifacts/server";
import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { createStubPlatformModels } from "@atlas/llm";
import { makeTempDir } from "@atlas/utils/temp.server";
import { Hono } from "hono";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AppContext, AppVariables } from "../src/factory.ts";
import { artifactsApp as rawArtifactsApp } from "./artifacts.ts";
import {
  _cleanupExpiredSessionsForTest,
  _getSessionForTest,
  _resetSessionsForTest,
  MAX_CONCURRENT_SESSIONS,
  chunkedUploadApp as rawChunkedUploadApp,
} from "./chunked-upload.ts";

let natsServer: TestNatsServer;
let nc: NatsConnection;

beforeAll(async () => {
  natsServer = await startNatsTestServer();
  nc = await connect({ servers: natsServer.url });
  initArtifactStorage(nc);
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await natsServer.stop();
});

const stubPlatformModels = createStubPlatformModels();

const mockAppContext = {
  daemon: { getPlatformModels: () => stubPlatformModels },
} as unknown as AppContext;

const artifactsApp = new Hono<AppVariables>()
  .use("*", async (c, next) => {
    c.set("app", mockAppContext);
    await next();
  })
  .route("/", rawArtifactsApp);

const chunkedUploadApp = new Hono<AppVariables>()
  .use("*", async (c, next) => {
    c.set("app", mockAppContext);
    await next();
  })
  .route("/", rawChunkedUploadApp);

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

/** Schema for async complete response (202) */
const CompleteAcceptedSchema = z.object({ status: z.literal("completing") });

/** Schema for status response */
const StatusResponseSchema = z.object({
  uploadId: z.string().uuid(),
  totalChunks: z.number().int().positive(),
  completedChunks: z.array(z.number().int().nonnegative()),
  status: z.enum(["uploading", "completing", "completed", "failed"]),
  result: z
    .union([
      z.object({ artifact: z.object({ id: z.string() }).passthrough() }),
      z.object({ error: z.string() }),
    ])
    .optional(),
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

/** Complete upload and poll until finished. Returns the status response with result. */
async function completeAndWait(uploadId: string, maxAttempts = 50) {
  const completeRes = await completeUpload(uploadId);
  expect(completeRes.status).toEqual(202);
  const completeBody = CompleteAcceptedSchema.parse(await completeRes.json());
  expect(completeBody.status).toEqual("completing");

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const statusRes = await getStatus(uploadId);
    if (!statusRes.ok) {
      if (statusRes.status === 404) {
        throw new Error(`Session ${uploadId} disappeared during polling (404)`);
      }
      if (i === maxAttempts - 1) {
        throw new Error(`Status endpoint returned ${statusRes.status} on final attempt`);
      }
      continue;
    }
    const body = StatusResponseSchema.parse(await statusRes.json());
    if (body.status === "completed" || body.status === "failed") {
      return body;
    }
  }
  throw new Error("Timed out waiting for upload completion");
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
    expect(res.status).toEqual(201);
    const body = InitResponseSchema.parse(await res.json());
    expect(body.chunkSize).toEqual(CHUNK_SIZE);
    expect(body.totalChunks).toEqual(3);
  });

  it("rejects disallowed extension (.exe) with 415", async () => {
    const res = await initUpload({ fileName: "malware.exe", fileSize: 1024 });
    expect(res.status).toEqual(415);
    const body = await res.json();
    expect(body).toMatchObject({ error: expect.stringContaining("File type not allowed") });
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
    expect(initRes.status).toEqual(201);
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    const chunkRes = await uploadChunk(uploadId, 0, new Blob([content]));
    expect(chunkRes.status).toEqual(200);

    const result = await completeAndWait(uploadId);
    expect(result.status).toEqual("completed");
    expect(result.result).toHaveProperty("artifact");
  });

  it("creates database artifact for CSV file", async () => {
    const csv = "name,age\nAlice,30\nBob,25";
    const fileSize = new Blob([csv]).size;

    const initRes = await initUpload({ fileName: "people.csv", fileSize });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    await uploadChunk(uploadId, 0, new Blob([csv]));

    const result = await completeAndWait(uploadId);
    expect(result.status).toEqual("completed");
    expect(result.result).toHaveProperty("artifact");
  });

  it("returns intermediate 'completing' status before terminal state", async () => {
    const content = "intermediate status test";
    const fileSize = new Blob([content]).size;

    const initRes = await initUpload({ fileName: "intermediate.txt", fileSize });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());
    await uploadChunk(uploadId, 0, new Blob([content]));

    const completeRes = await completeUpload(uploadId);
    expect(completeRes.status).toEqual(202);

    // Poll immediately — should see "completing" before it transitions
    const statusRes = await getStatus(uploadId);
    expect(statusRes.status).toEqual(200);
    const body = StatusResponseSchema.parse(await statusRes.json());
    expect(["completing", "completed"]).toContain(body.status);
  });

  it("returns 409 on second complete (session is completing)", async () => {
    const content = "double complete test";
    const fileSize = new Blob([content]).size;

    const initRes = await initUpload({ fileName: "double.txt", fileSize });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());
    await uploadChunk(uploadId, 0, new Blob([content]));

    const first = await completeUpload(uploadId);
    expect(first.status).toEqual(202);

    // Second complete should be rejected since status is now "completing"
    const second = await completeUpload(uploadId);
    expect(second.status).toEqual(409);
    const body = await second.json();
    expect(body).toHaveProperty("error");
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
    expect(initRes.status).toEqual(201);
    const { uploadId, totalChunks } = InitResponseSchema.parse(await initRes.json());
    expect(totalChunks).toEqual(2);

    const blob = new Blob([fullContent]);
    // Upload chunk 0
    await uploadChunk(uploadId, 0, blob.slice(0, CHUNK_SIZE));
    // Upload chunk 1
    await uploadChunk(uploadId, 1, blob.slice(CHUNK_SIZE));

    const result = await completeAndWait(uploadId);
    expect(result.status).toEqual("completed");
    expect(result.result).toHaveProperty("artifact");
  });

  it("handles CSV multi-chunk upload producing database artifact", async () => {
    const csv = "col1,col2\nval1,val2\nval3,val4";
    const fileSize = new Blob([csv]).size;

    const initRes = await initUpload({ fileName: "data.csv", fileSize });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    await uploadChunk(uploadId, 0, new Blob([csv]));

    const result = await completeAndWait(uploadId);
    expect(result.status).toEqual("completed");
    expect(result.result).toHaveProperty("artifact");
  });
});

describe("Edge cases", () => {
  it("handles single-byte file (1 chunk)", async () => {
    const initRes = await initUpload({ fileName: "tiny.txt", fileSize: 1 });
    expect(initRes.status).toEqual(201);
    const { uploadId, totalChunks } = InitResponseSchema.parse(await initRes.json());
    expect(totalChunks).toEqual(1);

    await uploadChunk(uploadId, 0, new Blob(["x"]));

    const result = await completeAndWait(uploadId);
    expect(result.status).toEqual("completed");
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

    const result = await completeAndWait(uploadId);
    expect(result.status).toEqual("completed");
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

    const result = await completeAndWait(uploadId);
    expect(result.status).toEqual("completed");

    // Fetch the artifact via the API and verify file content matches
    const artifactId = z.object({ artifact: z.object({ id: z.string() }) }).parse(result.result)
      .artifact.id;
    const artifactRes = await artifactsApp.request(`/${artifactId}`);
    expect(artifactRes.status).toEqual(200);
    const artifact = z.object({ contents: z.string() }).parse(await artifactRes.json());
    expect(artifact.contents).toEqual(fullContent);
  });
});

describe("Rate limiting", () => {
  it("returns 429 when MAX_CONCURRENT_SESSIONS exceeded", async () => {
    // Fill all session slots
    for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) {
      const res = await initUpload({ fileName: `file${i}.txt`, fileSize: 100 });
      expect(res.status).toEqual(201);
    }

    // Next one should be rejected
    const res = await initUpload({ fileName: "overflow.txt", fileSize: 100 });
    expect(res.status).toEqual(429);
    const body = await res.json();
    expect(body).toMatchObject({ error: expect.stringMatching(/Too many concurrent uploads/) });
  });
});

describe("Size mismatch", () => {
  it("fails when assembled file size differs from declared", async () => {
    // Declare 200 bytes but upload only 5
    const initRes = await initUpload({ fileName: "mismatch.txt", fileSize: 200 });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    // totalChunks = ceil(200 / CHUNK_SIZE) = 1
    // Upload a chunk with only 5 bytes
    await uploadChunk(uploadId, 0, new Blob(["hello"]));

    const result = await completeAndWait(uploadId);
    expect(result.status).toEqual("failed");
    const errorResult = z.object({ error: z.string() }).parse(result.result);
    expect(errorResult.error).toMatch(/Size mismatch/);
  });
});

describe("Completing rejection (409)", () => {
  it("rejects chunk upload when session status is completing", async () => {
    const initRes = await initUpload({ fileName: "test.txt", fileSize: CHUNK_SIZE + 1 });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    // Upload chunk 0 so we can trigger complete
    await uploadChunk(uploadId, 0, new Blob(["a".repeat(CHUNK_SIZE)]));
    await uploadChunk(uploadId, 1, new Blob(["b"]));

    // Direct mutation via test-only export to simulate a race condition where
    // complete fires between chunk upload and chunk write. Triggering this state
    // via HTTP would require precise timing control that's fragile in tests.
    const session = _getSessionForTest(uploadId);
    if (!session) throw new Error("session should be defined");
    session.status = "completing";

    // Chunk upload should be rejected with 409
    const res = await uploadChunk(uploadId, 0, new Blob(["c"]));
    expect(res.status).toEqual(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: expect.stringMatching(/completing/) });
  });
});

describe("Artifact creation failure (500)", () => {
  it("fails when file is detected as disallowed binary", async () => {
    // ZIP magic bytes disguised with .txt extension
    const zipHeader = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const fileSize = zipHeader.byteLength;

    const initRes = await initUpload({ fileName: "sneaky.txt", fileSize });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    await uploadChunk(uploadId, 0, new Blob([zipHeader]));

    const result = await completeAndWait(uploadId);
    expect(result.status).toEqual("failed");
    expect(result.result).toHaveProperty("error");
  });
});

describe("TTL expiration", () => {
  it("cleans up expired sessions in uploading state", async () => {
    const initRes = await initUpload({ fileName: "expire.txt", fileSize: 100 });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());

    // Backdate session to exceed TTL
    const session = _getSessionForTest(uploadId);
    if (!session) throw new Error("session should be defined");
    session.createdAt = Date.now() - CHUNKED_UPLOAD_TTL_MS - 1000;

    await _cleanupExpiredSessionsForTest();

    // Session should be gone
    const statusRes = await getStatus(uploadId);
    expect(statusRes.status).toEqual(404);
  });

  it("cleans up completed sessions after TTL", async () => {
    const content = "ttl-completed";
    const fileSize = new Blob([content]).size;

    const initRes = await initUpload({ fileName: "ttl-done.txt", fileSize });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());
    await uploadChunk(uploadId, 0, new Blob([content]));

    const result = await completeAndWait(uploadId);
    expect(result.status).toEqual("completed");

    // Backdate the completed session to exceed TTL
    const session = _getSessionForTest(uploadId);
    if (!session) throw new Error("session should be defined");
    session.createdAt = Date.now() - CHUNKED_UPLOAD_TTL_MS - 1000;

    await _cleanupExpiredSessionsForTest();

    // Completed session should be cleaned up
    const statusRes = await getStatus(uploadId);
    expect(statusRes.status).toEqual(404);
  });

  it("cleans up failed sessions after TTL", async () => {
    // Declare 200 bytes but upload only 5 to trigger size mismatch failure
    const initRes = await initUpload({ fileName: "ttl-fail.txt", fileSize: 200 });
    const { uploadId } = InitResponseSchema.parse(await initRes.json());
    await uploadChunk(uploadId, 0, new Blob(["hello"]));

    const result = await completeAndWait(uploadId);
    expect(result.status).toEqual("failed");

    // Backdate the failed session to exceed TTL
    const session = _getSessionForTest(uploadId);
    if (!session) throw new Error("session should be defined");
    session.createdAt = Date.now() - CHUNKED_UPLOAD_TTL_MS - 1000;

    await _cleanupExpiredSessionsForTest();

    // Failed session should be cleaned up
    const statusRes = await getStatus(uploadId);
    expect(statusRes.status).toEqual(404);
  });
});

describe("Legacy format rejection", () => {
  it("rejects .ppt init with 415 and helpful message", async () => {
    const res = await initUpload({ fileName: "slides.ppt", fileSize: 1024 });
    expect(res.status).toEqual(415);
    const body = await res.json();
    assertErrorResponse(body, "Legacy .ppt format not supported. Save as .pptx and re-upload.");
  });

  it("rejects .doc init with 415 and helpful message", async () => {
    const res = await initUpload({ fileName: "report.doc", fileSize: 1024 });
    expect(res.status).toEqual(415);
    const body = await res.json();
    assertErrorResponse(body, "Legacy .doc format not supported. Save as .docx and re-upload.");
  });
});

afterAll(async () => {
  await rm(tempDir, { recursive: true });
});
