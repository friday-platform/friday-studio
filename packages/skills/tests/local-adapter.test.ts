import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@std/path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSkillAdapter } from "../src/local-adapter.ts";

describe("LocalSkillAdapter", () => {
  let adapter: LocalSkillAdapter;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `skills-test-${Date.now()}.db`);
    adapter = new LocalSkillAdapter(dbPath);
  });

  afterEach(() => {
    try {
      rmSync(dbPath);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  it("creates and retrieves skill", async () => {
    const result = await adapter.create("user-1", {
      name: "test-skill",
      description: "Test",
      instructions: "Do stuff",
      workspaceId: "ws-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const get = await adapter.get(result.data.id);
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    expect(get.data?.name).toBe("test-skill");
  });

  it("enforces unique workspace+name", async () => {
    const input = { name: "dupe", description: "A", instructions: "B", workspaceId: "ws-1" };
    await adapter.create("user-1", input);
    const dupe = await adapter.create("user-2", input);
    expect(dupe.ok).toBe(false);
    if (dupe.ok) return;
    expect(dupe.error.includes("already exists")).toBe(true);
  });

  it("lists skills by workspace", async () => {
    await adapter.create("u", {
      name: "a",
      description: "A",
      instructions: ".",
      workspaceId: "ws-1",
    });
    await adapter.create("u", {
      name: "b",
      description: "B",
      instructions: ".",
      workspaceId: "ws-2",
    });
    const list = await adapter.list("ws-1");
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.length).toBe(1);
    expect(list.data[0]?.name).toBe("a");
  });

  it("getByName finds correct skill", async () => {
    await adapter.create("u", {
      name: "target",
      description: "X",
      instructions: ".",
      workspaceId: "ws-1",
    });
    const result = await adapter.getByName("target", "ws-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data?.name).toBe("target");
  });

  it("getByName returns null for non-existent skill", async () => {
    const result = await adapter.getByName("missing", "ws-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe(null);
  });

  it("updates skill fields", async () => {
    const created = await adapter.create("u", {
      name: "updatable",
      description: "Original",
      instructions: "Original instructions",
      workspaceId: "ws-1",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await adapter.update(created.data.id, {
      description: "Updated",
      instructions: "New instructions",
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.data.description).toBe("Updated");
    expect(updated.data.instructions).toBe("New instructions");
    expect(updated.data.name).toBe("updatable"); // unchanged
  });

  it("update returns error for non-existent skill", async () => {
    const result = await adapter.update("nonexistent-id", { description: "New" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.includes("not found")).toBe(true);
  });

  it("deletes skill", async () => {
    const created = await adapter.create("u", {
      name: "deletable",
      description: "To be deleted",
      instructions: ".",
      workspaceId: "ws-1",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const deleteResult = await adapter.delete(created.data.id);
    expect(deleteResult.ok).toBe(true);

    const get = await adapter.get(created.data.id);
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    expect(get.data).toBe(null);
  });

  it("get returns null for non-existent id", async () => {
    const result = await adapter.get("nonexistent-id");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe(null);
  });
});
