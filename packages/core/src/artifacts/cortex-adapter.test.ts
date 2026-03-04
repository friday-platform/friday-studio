import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { makeTempDir } from "@atlas/utils/temp.server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CortexStorageAdapter } from "./cortex-adapter.ts";
import { createFileArtifactInput } from "./test-utils/shared-fixtures.ts";

/** Mirrors the private CortexObject interface from cortex-adapter.ts for testing. */
interface CortexObject {
  id: string;
  user_id: string;
  content_size: number | null;
  metadata: {
    artifact_id: string;
    revision: number;
    artifact_type: string;
    title: string;
    summary: string;
    workspace_id?: string;
    chat_id?: string;
    is_latest: boolean;
    created_at: string;
    revision_message?: string;
    slug?: string;
    source?: string;
  };
  created_at: string;
  updated_at: string;
}

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

/**
 * Build a CortexObject for use in list/get test mocks.
 */
function makeCortexObject(overrides: {
  id?: string;
  artifactId: string;
  revision?: number;
  isLatest?: boolean;
  workspaceId?: string;
  chatId?: string;
  artifactType?: string;
  revisionMessage?: string;
  slug?: string;
  source?: string;
}): CortexObject {
  return {
    id: overrides.id ?? `cortex-${overrides.artifactId}`,
    user_id: "user-1",
    content_size: 100,
    metadata: {
      artifact_id: overrides.artifactId,
      revision: overrides.revision ?? 1,
      artifact_type: overrides.artifactType ?? "summary",
      title: `Artifact ${overrides.artifactId}`,
      summary: "Test artifact",
      workspace_id: overrides.workspaceId,
      chat_id: overrides.chatId,
      is_latest: overrides.isLatest ?? true,
      created_at: new Date().toISOString(),
      revision_message: overrides.revisionMessage,
      slug: overrides.slug,
      source: overrides.source,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/** JSON blob content that parses as a valid summary artifact */
const SUMMARY_BLOB = JSON.stringify({ type: "summary", version: 1, data: "Test summary content" });

describe("CortexStorageAdapter: list race condition fallback", () => {
  it("listByWorkspace returns artifacts when is_latest=true query is empty during update window", async () => {
    const adapter = new CortexStorageAdapter("http://localhost:9999");
    const workspaceId = "ws-1";

    // Artifact mid-update: both old and new revisions have is_latest=false
    const oldRevision = makeCortexObject({
      id: "cortex-old",
      artifactId: "art-1",
      revision: 1,
      isLatest: false,
      workspaceId,
    });
    const newRevision = makeCortexObject({
      id: "cortex-new",
      artifactId: "art-1",
      revision: 2,
      isLatest: false,
      workspaceId,
    });

    const fetchSpy = vi.fn((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

      // First call: is_latest=true query returns empty
      if (urlStr.includes("is_latest=true")) {
        return Response.json([]);
      }

      // Fallback call: query without is_latest returns both revisions
      if (urlStr.includes("workspace_id=") && !urlStr.includes("is_latest")) {
        return Response.json([oldRevision, newRevision]);
      }

      // Blob download for the winning revision
      if (urlStr.includes("/objects/cortex-new")) {
        return new Response(SUMMARY_BLOB);
      }

      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await adapter.listByWorkspace({ workspaceId });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.id).toBe("art-1");
      expect(result.data[0]?.revision).toBe(2);
    }
  });

  it("listByChat returns artifacts when is_latest=true query is empty during update window", async () => {
    const adapter = new CortexStorageAdapter("http://localhost:9999");
    const chatId = "chat-1";

    const obj = makeCortexObject({
      id: "cortex-obj",
      artifactId: "art-2",
      revision: 3,
      isLatest: false,
      chatId,
    });

    const fetchSpy = vi.fn((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes("is_latest=true")) {
        return Response.json([]);
      }
      if (urlStr.includes("chat_id=") && !urlStr.includes("is_latest")) {
        return Response.json([obj]);
      }
      if (urlStr.includes("/objects/cortex-obj")) {
        return new Response(SUMMARY_BLOB);
      }

      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await adapter.listByChat({ chatId });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.id).toBe("art-2");
      expect(result.data[0]?.revision).toBe(3);
    }
  });

  it("listAll returns artifacts when is_latest=true query is empty during update window", async () => {
    const adapter = new CortexStorageAdapter("http://localhost:9999");

    const obj = makeCortexObject({
      id: "cortex-all",
      artifactId: "art-3",
      revision: 1,
      isLatest: false,
    });

    const fetchSpy = vi.fn((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes("is_latest=true")) {
        return Response.json([]);
      }
      if (urlStr.includes("/objects?") && !urlStr.includes("is_latest")) {
        return Response.json([obj]);
      }
      if (urlStr.includes("/objects/cortex-all")) {
        return new Response(SUMMARY_BLOB);
      }

      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await adapter.listAll({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.id).toBe("art-3");
    }
  });

  it("skips fallback when primary query returns results", async () => {
    const adapter = new CortexStorageAdapter("http://localhost:9999");
    const workspaceId = "ws-1";

    const stableArtifact = makeCortexObject({
      id: "cortex-stable",
      artifactId: "art-stable",
      revision: 1,
      isLatest: true,
      workspaceId,
    });

    const fetchSpy = vi.fn((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes("is_latest=true")) {
        return Response.json([stableArtifact]);
      }
      if (urlStr.includes("/objects/cortex-stable")) {
        return new Response(SUMMARY_BLOB);
      }

      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await adapter.listByWorkspace({ workspaceId });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.id).toBe("art-stable");
    }

    // Only 2 fetch calls: primary list + blob download. No fallback query.
    const listCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes("/objects?"));
    expect(listCalls).toHaveLength(1);
  });

  it("fallback gracefully degrades on error", async () => {
    const adapter = new CortexStorageAdapter("http://localhost:9999");
    const workspaceId = "ws-1";

    const fetchSpy = vi.fn((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

      // Primary query returns empty
      if (urlStr.includes("is_latest=true")) {
        return Response.json([]);
      }
      // Fallback query throws
      if (urlStr.includes("workspace_id=") && !urlStr.includes("is_latest")) {
        throw new Error("network error");
      }

      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await adapter.listByWorkspace({ workspaceId });

    // Should return empty rather than throwing
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(0);
    }
  });
});

describe("CortexStorageAdapter: full-data list includes metadata fields", () => {
  it("listAll with default includeData returns revisionMessage, slug, and source from metadata", async () => {
    const adapter = new CortexStorageAdapter("http://localhost:9999");

    const obj = makeCortexObject({
      id: "cortex-full-1",
      artifactId: "art-full-1",
      revision: 2,
      workspaceId: "ws-1",
      revisionMessage: "updated layout",
      slug: "weekly-report",
      source: "planner-agent",
    });

    const fetchSpy = vi.fn((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes("/objects?")) {
        return Response.json([obj]);
      }
      // Blob download
      if (urlStr.includes("/objects/cortex-full-1")) {
        return new Response(SUMMARY_BLOB);
      }

      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await adapter.listAll({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      const artifact = result.data[0];
      if (!artifact) throw new Error("expected artifact");
      expect(artifact.revisionMessage).toBe("updated layout");
      expect(artifact.slug).toBe("weekly-report");
      expect(artifact.source).toBe("planner-agent");
      // Full-data path includes data
      expect("data" in artifact).toBe(true);
    }

    // 2 fetch calls: metadata list query + blob download. Proves full-data path ran.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("CortexStorageAdapter: includeData=false (metadata-only)", () => {
  it("listAll skips blob downloads and returns summaries from metadata", async () => {
    const adapter = new CortexStorageAdapter("http://localhost:9999");

    const obj = makeCortexObject({
      id: "cortex-summary-1",
      artifactId: "art-sum-1",
      revision: 3,
      workspaceId: "ws-1",
      revisionMessage: "third revision",
      slug: "my-artifact",
      source: "test-agent",
    });

    const fetchSpy = vi.fn((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes("/objects?")) {
        return Response.json([obj]);
      }

      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await adapter.listAll({ includeData: false });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      const summary = result.data[0];
      if (!summary) throw new Error("expected summary");
      expect(summary.id).toBe("art-sum-1");
      expect(summary.type).toBe("summary");
      expect(summary.revision).toBe(3);
      expect(summary.title).toBe("Artifact art-sum-1");
      expect(summary.summary).toBe("Test artifact");
      expect(summary.workspaceId).toBe("ws-1");
      expect(summary.revisionMessage).toBe("third revision");
      expect(summary.slug).toBe("my-artifact");
      expect(summary.source).toBe("test-agent");
      // Should NOT have a data property
      expect("data" in summary).toBe(false);
    }

    // Only 1 fetch call: the metadata list query. No blob downloads.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("listByWorkspace with includeData=false skips blob downloads", async () => {
    const adapter = new CortexStorageAdapter("http://localhost:9999");

    const obj1 = makeCortexObject({ artifactId: "a1", workspaceId: "ws-1" });
    const obj2 = makeCortexObject({ artifactId: "a2", workspaceId: "ws-1" });

    const fetchSpy = vi.fn((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes("/objects?")) {
        return Response.json([obj1, obj2]);
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await adapter.listByWorkspace({ workspaceId: "ws-1", includeData: false });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(2);
      expect(result.data.every((s) => !("data" in s))).toBe(true);
    }

    // Only list query, no blob downloads
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("listByChat with includeData=false skips blob downloads", async () => {
    const adapter = new CortexStorageAdapter("http://localhost:9999");

    const obj = makeCortexObject({ artifactId: "a1", chatId: "chat-1" });

    const fetchSpy = vi.fn((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes("/objects?")) {
        return Response.json([obj]);
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await adapter.listByChat({ chatId: "chat-1", includeData: false });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      const first = result.data[0];
      if (!first) throw new Error("expected first element");
      expect("data" in first).toBe(false);
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("skips objects with non-ISO created_at via Zod datetime validation", async () => {
    const adapter = new CortexStorageAdapter("http://localhost:9999");

    const goodObj = makeCortexObject({ artifactId: "good", artifactType: "summary" });
    const badObj = makeCortexObject({ artifactId: "bad", artifactType: "summary" });
    // Corrupt the created_at to a non-ISO datetime string
    badObj.metadata.created_at = "not-a-date";

    const fetchSpy = vi.fn((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes("/objects?")) {
        return Response.json([goodObj, badObj]);
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await adapter.listAll({ includeData: false });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.id).toBe("good");
    }
  });

  it("skips objects with invalid artifact_type metadata", async () => {
    const adapter = new CortexStorageAdapter("http://localhost:9999");

    const goodObj = makeCortexObject({ artifactId: "good", artifactType: "summary" });
    const badObj = makeCortexObject({ artifactId: "bad", artifactType: "nonexistent-type" });

    const fetchSpy = vi.fn((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes("/objects?")) {
        return Response.json([goodObj, badObj]);
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await adapter.listAll({ includeData: false });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only the valid one should be returned
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.id).toBe("good");
    }
  });
});

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
