import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MdNarrativeStore } from "../src/md-narrative-store.ts";

describe("MdNarrativeStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "md-narrative-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("append writes to MEMORY.md", async () => {
    const store = new MdNarrativeStore({ workspaceRoot: tmpDir });
    const entry = { id: "entry-1", text: "hello world", createdAt: "2026-04-14T00:00:00Z" };

    const result = await store.append(entry);

    expect(result.id).toBe("entry-1");
    expect(result.text).toBe("hello world");
    expect(result.createdAt).toBe("2026-04-14T00:00:00Z");

    const content = await fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf-8");
    expect(content).toContain("hello world");
    expect(content).toContain("entry-1");
  });

  it("append creates file if missing", async () => {
    const memoryPath = path.join(tmpDir, "MEMORY.md");

    await expect(fs.access(memoryPath)).rejects.toThrow();

    const store = new MdNarrativeStore({ workspaceRoot: tmpDir });
    await store.append({ id: "entry-2", text: "created file", createdAt: "2026-04-14T00:00:00Z" });

    const content = await fs.readFile(memoryPath, "utf-8");
    expect(content).toContain("created file");
    expect(content).toContain("entry-2");
  });

  it("two appends preserve order", async () => {
    const store = new MdNarrativeStore({ workspaceRoot: tmpDir });

    await store.append({ id: "entry-a", text: "first", createdAt: "2026-04-14T00:00:00Z" });
    await store.append({ id: "entry-b", text: "second", createdAt: "2026-04-14T00:01:00Z" });

    const content = await fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf-8");
    expect(content.indexOf("first")).toBeLessThan(content.indexOf("second"));
  });
});
