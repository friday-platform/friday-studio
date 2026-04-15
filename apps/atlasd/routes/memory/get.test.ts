import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MdNarrativeCorpus } from "@atlas/adapters-md";
import { NarrativeEntrySchema } from "@atlas/agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { memoryNarrativeRoutes } from "./index.ts";

let mockAtlasHome = "";

vi.mock("@atlas/utils/paths.server", () => ({ getAtlasHome: () => mockAtlasHome }));

const EntryArraySchema = z.array(NarrativeEntrySchema);

describe("GET /api/memory/:workspaceId/narrative/:memoryName", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-route-"));
    mockAtlasHome = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 200 + NarrativeEntry[] for a populated corpus", async () => {
    const memoryDir = path.join(tmpDir, "memory", "ws1", "narrative", "backlog");
    await fs.mkdir(memoryDir, { recursive: true });

    const corpus = new MdNarrativeCorpus({ workspaceRoot: memoryDir });
    await corpus.append({ id: "e1", text: "task one", createdAt: "2026-04-14T00:00:00Z" });

    const res = await memoryNarrativeRoutes.request("/ws1/narrative/backlog");
    expect(res.status).toBe(200);

    const body = EntryArraySchema.parse(await res.json());
    expect(body).toHaveLength(1);
    const [first] = body;
    expect(first).toBeDefined();
    expect(first?.id).toBe("e1");
    expect(first?.text).toBe("task one");
  });

  it("returns 200 + [] for nonexistent corpus (not 404)", async () => {
    const res = await memoryNarrativeRoutes.request("/ws1/narrative/missing");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("forwards since and limit query params to read()", async () => {
    const memoryDir = path.join(tmpDir, "memory", "ws1", "narrative", "backlog");
    await fs.mkdir(memoryDir, { recursive: true });

    const corpus = new MdNarrativeCorpus({ workspaceRoot: memoryDir });
    await corpus.append({ id: "e1", text: "old", createdAt: "2026-04-14T00:00:00Z" });
    await corpus.append({ id: "e2", text: "new", createdAt: "2026-04-14T12:00:00Z" });

    const res = await memoryNarrativeRoutes.request(
      "/ws1/narrative/backlog?since=2026-04-14T06:00:00Z&limit=10",
    );
    expect(res.status).toBe(200);

    const body = EntryArraySchema.parse(await res.json());
    expect(body).toHaveLength(1);
    const [first] = body;
    expect(first?.id).toBe("e2");
  });
});

describe("POST /api/memory/:workspaceId/narrative/:memoryName", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-route-"));
    mockAtlasHome = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("appends entry with generated id and createdAt when only text provided", async () => {
    const memoryDir = path.join(tmpDir, "memory", "ws1", "narrative", "notes");
    await fs.mkdir(memoryDir, { recursive: true });

    const res = await memoryNarrativeRoutes.request("/ws1/narrative/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "remember this" }),
    });
    expect(res.status).toBe(200);

    const body = NarrativeEntrySchema.parse(await res.json());
    expect(body.text).toBe("remember this");
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.createdAt.length).toBeGreaterThan(0);
  });

  it("preserves supplied id and createdAt", async () => {
    const memoryDir = path.join(tmpDir, "memory", "ws1", "narrative", "notes");
    await fs.mkdir(memoryDir, { recursive: true });

    const res = await memoryNarrativeRoutes.request("/ws1/narrative/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "custom-id",
        text: "explicit entry",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    });
    expect(res.status).toBe(200);

    const body = NarrativeEntrySchema.parse(await res.json());
    expect(body.id).toBe("custom-id");
    expect(body.text).toBe("explicit entry");
    expect(body.createdAt).toBe("2026-01-01T00:00:00Z");
  });

  it("returns 400 for invalid body (empty object)", async () => {
    const res = await memoryNarrativeRoutes.request("/ws1/narrative/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/memory/:workspaceId/narrative/:memoryName/:entryId", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-route-"));
    mockAtlasHome = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 501 since MdNarrativeCorpus.forget() is not implemented", async () => {
    const memoryDir = path.join(tmpDir, "memory", "ws1", "narrative", "notes");
    await fs.mkdir(memoryDir, { recursive: true });

    const res = await memoryNarrativeRoutes.request("/ws1/narrative/notes/some-id", {
      method: "DELETE",
    });
    expect(res.status).toBe(501);

    const body = z.object({ error: z.string() }).parse(await res.json());
    expect(body.error).toContain("not implemented");
  });
});
