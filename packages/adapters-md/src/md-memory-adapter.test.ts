import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MdMemoryAdapter } from "./md-memory-adapter.ts";
import { MdNarrativeCorpus } from "./md-narrative-corpus.ts";
import { NotImplementedError } from "./md-skill-adapter.ts";

describe("MdMemoryAdapter", () => {
  let tmpDir: string;
  let adapter: MdMemoryAdapter;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "md-memory-test-"));
    adapter = new MdMemoryAdapter({ root: tmpDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("corpus(narrative) returns a NarrativeCorpus", async () => {
    const corpus = await adapter.corpus("ws-1", "test", "narrative");

    expect(typeof corpus.append).toBe("function");
    expect(typeof corpus.read).toBe("function");
    expect(typeof corpus.search).toBe("function");
    expect(typeof corpus.forget).toBe("function");
    expect(typeof corpus.render).toBe("function");
  });

  it("corpus(retrieval) throws NotImplementedError", async () => {
    await expect(adapter.corpus("ws-1", "test", "retrieval")).rejects.toThrow(NotImplementedError);
    await expect(adapter.corpus("ws-1", "test", "retrieval")).rejects.toThrow(
      /retrieval backend not implemented/,
    );
  });

  it("list() returns metadata for created corpora", async () => {
    await adapter.corpus("ws-1", "alpha", "narrative");
    await adapter.corpus("ws-1", "beta", "narrative");

    const items = await adapter.list("ws-1");
    expect(items).toHaveLength(2);

    const names = items.map((i) => i.name).sort();
    expect(names).toEqual(["alpha", "beta"]);

    for (const item of items) {
      expect(item.kind).toBe("narrative");
      expect(item.workspaceId).toBe("ws-1");
    }
  });

  it("bootstrap() returns rendered narrative content", async () => {
    await adapter.corpus("ws-1", "daily", "narrative");

    vi.spyOn(MdNarrativeCorpus.prototype, "render").mockResolvedValue(
      "# Daily Memory\nSome content",
    );

    const result = await adapter.bootstrap("ws-1", "agent-1");
    expect(result).toBe("# Daily Memory\nSome content");
  });

  it("bootstrap() returns empty string when no corpora exist", async () => {
    const result = await adapter.bootstrap("ws-empty", "agent-1");
    expect(result).toBe("");
  });
});
