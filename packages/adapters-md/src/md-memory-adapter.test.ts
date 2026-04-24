import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MdMemoryAdapter } from "./md-memory-adapter.ts";
import { MdNarrativeStore } from "./md-narrative-store.ts";
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

  it("store(narrative) returns a NarrativeStore", async () => {
    const store = await adapter.store("ws-1", "test", "narrative");

    expect(typeof store.append).toBe("function");
    expect(typeof store.read).toBe("function");
    expect(typeof store.search).toBe("function");
    expect(typeof store.forget).toBe("function");
    expect(typeof store.render).toBe("function");
  });

  it("store(retrieval) throws NotImplementedError", async () => {
    await expect(adapter.store("ws-1", "test", "retrieval")).rejects.toThrow(NotImplementedError);
    await expect(adapter.store("ws-1", "test", "retrieval")).rejects.toThrow(
      /retrieval backend not implemented/,
    );
  });

  it("list() returns metadata for created stores", async () => {
    await adapter.store("ws-1", "alpha", "narrative");
    await adapter.store("ws-1", "beta", "narrative");

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
    await adapter.store("ws-1", "daily", "narrative");

    vi.spyOn(MdNarrativeStore.prototype, "render").mockResolvedValue(
      "# Daily Memory\nSome content",
    );

    const result = await adapter.bootstrap("ws-1", "agent-1");
    expect(result).toBe("# Daily Memory\nSome content");
  });

  it("bootstrap() returns empty string when no stores exist", async () => {
    const result = await adapter.bootstrap("ws-empty", "agent-1");
    expect(result).toBe("");
  });

  describe("ensureRoot()", () => {
    it("creates the narrative directory for the given workspace and memory name", async () => {
      await adapter.ensureRoot("ws1", "foo");
      const dir = path.join(tmpDir, "memory", "ws1", "narrative", "foo");
      const stats = await fs.stat(dir);
      expect(stats.isDirectory()).toBe(true);
    });

    it("is idempotent — calling twice does not error", async () => {
      await adapter.ensureRoot("ws1", "foo");
      await adapter.ensureRoot("ws1", "foo");
      const dir = path.join(tmpDir, "memory", "ws1", "narrative", "foo");
      const stats = await fs.stat(dir);
      expect(stats.isDirectory()).toBe(true);
    });

    it("creates an empty directory (no MEMORY.md, no entries.jsonl)", async () => {
      await adapter.ensureRoot("ws1", "bar");
      const dir = path.join(tmpDir, "memory", "ws1", "narrative", "bar");
      const contents = await fs.readdir(dir);
      expect(contents).toEqual([]);
    });
  });
});
