import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { makeTempDir } from "@atlas/utils/temp.server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CortexStorageAdapter } from "./cortex-adapter.ts";
import { createFileArtifactInput } from "./test-utils/shared-fixtures.ts";

let tempDir: string;
let originalAtlasKey: string | undefined;

beforeEach(() => {
  tempDir = makeTempDir({ prefix: "cortex-adapter-test-" });
  originalAtlasKey = process.env.ATLAS_KEY;
  process.env.ATLAS_KEY = "test-token";
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalAtlasKey !== undefined) {
    process.env.ATLAS_KEY = originalAtlasKey;
  } else {
    delete process.env.ATLAS_KEY;
  }
  try {
    await rm(tempDir, { recursive: true });
  } catch {
    // ignore
  }
});

/**
 * Build a mock fetch that handles the 3 POST /objects calls made by create()
 * for a file artifact:
 *   1. Binary stream upload → { id: binaryId }
 *   2. Artifact data JSON upload → { id: artifactDataId }
 *   3. Metadata POST → "ok"
 */
function mockCortexFetch(options?: { failBinaryUpload?: boolean }) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

    // Consume the body if it's a ReadableStream (simulates server reading the upload)
    if (init?.body instanceof ReadableStream) {
      const reader = init.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      if (options?.failBinaryUpload) {
        return new Response("Internal Server Error", { status: 500 });
      }

      return Response.json({ id: "binary-blob-id" });
    }

    // Artifact data JSON upload or metadata POST
    if (urlStr.includes("/metadata")) {
      return new Response("ok", { status: 200 });
    }

    return Response.json({ id: "artifact-data-id" });
  });
}

describe("CortexStorageAdapter: streaming upload", () => {
  it("succeeds without Bad resource ID after stream consumption", async () => {
    const filePath = join(tempDir, "test.csv");
    await writeFile(filePath, "id,name\n1,Alice\n2,Bob\n", "utf-8");

    const fetchSpy = mockCortexFetch();
    vi.stubGlobal("fetch", fetchSpy);

    const adapter = new CortexStorageAdapter("http://localhost:9999");
    const input = createFileArtifactInput(filePath);
    const result = await adapter.create(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.type).toBe("file");
    }
    // Verify all 3 requests were made (binary upload, artifact data, metadata)
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("returns failure when binary upload fails", async () => {
    const filePath = join(tempDir, "test.csv");
    await writeFile(filePath, "id,name\n1,Alice\n", "utf-8");

    const fetchSpy = mockCortexFetch({ failBinaryUpload: true });
    vi.stubGlobal("fetch", fetchSpy);

    const adapter = new CortexStorageAdapter("http://localhost:9999");
    const input = createFileArtifactInput(filePath);
    const result = await adapter.create(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("500");
    }
  });

  it("returns failure for non-existent file", async () => {
    vi.stubGlobal("fetch", mockCortexFetch());

    const adapter = new CortexStorageAdapter("http://localhost:9999");
    const input = createFileArtifactInput("/tmp/does-not-exist.csv");
    const result = await adapter.create(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("File not found");
    }
  });
});
