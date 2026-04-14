import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MdNarrativeCorpus } from "@atlas/adapters-md";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryNarrativeRoutes } from "./get.ts";

let mockAtlasHome = "";

vi.mock("@atlas/utils/paths.server", () => ({ getAtlasHome: () => mockAtlasHome }));

describe("GET /api/memory/:workspaceId/narrative/:corpusName", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-route-"));
    mockAtlasHome = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 200 + NarrativeEntry[] for a populated corpus", async () => {
    const corpusDir = path.join(tmpDir, "memory", "ws1", "narrative", "backlog");
    await fs.mkdir(corpusDir, { recursive: true });

    const corpus = new MdNarrativeCorpus({ workspaceRoot: corpusDir });
    await corpus.append({ id: "e1", text: "task one", createdAt: "2026-04-14T00:00:00Z" });

    const res = await memoryNarrativeRoutes.request("/ws1/narrative/backlog");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("e1");
    expect(body[0].text).toBe("task one");
  });

  it("returns 200 + [] for nonexistent corpus (not 404)", async () => {
    const res = await memoryNarrativeRoutes.request("/ws1/narrative/missing");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("forwards since and limit query params to read()", async () => {
    const corpusDir = path.join(tmpDir, "memory", "ws1", "narrative", "backlog");
    await fs.mkdir(corpusDir, { recursive: true });

    const corpus = new MdNarrativeCorpus({ workspaceRoot: corpusDir });
    await corpus.append({ id: "e1", text: "old", createdAt: "2026-04-14T00:00:00Z" });
    await corpus.append({ id: "e2", text: "new", createdAt: "2026-04-14T12:00:00Z" });

    const res = await memoryNarrativeRoutes.request(
      "/ws1/narrative/backlog?since=2026-04-14T06:00:00Z&limit=10",
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("e2");
  });
});
