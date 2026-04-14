import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MdSkillAdapter, NotImplementedError } from "./md-skill-adapter.ts";

describe("MdSkillAdapter", () => {
  let tmpDir: string;
  let adapter: MdSkillAdapter;
  const workspaceId = "test-workspace";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "md-skill-"));
    adapter = new MdSkillAdapter({ root: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("create+get roundtrip", async () => {
    const draft = {
      name: "my-skill",
      description: "A test skill",
      instructions: "Do the thing.\nWith multiple lines.",
    };

    const created = await adapter.create(workspaceId, draft);
    expect(created.name).toBe("my-skill");
    expect(created.description).toBe("A test skill");
    expect(created.instructions).toBe("Do the thing.\nWith multiple lines.");
    expect(created.version).toBe("1");

    const fetched = await adapter.get(workspaceId, "my-skill");
    expect(fetched).toBeDefined();
    expect(fetched?.name).toBe("my-skill");
    expect(fetched?.description).toBe("A test skill");
    expect(fetched?.instructions).toBe("Do the thing.\nWith multiple lines.");
    expect(fetched?.version).toBe("1");
  });

  it("list returns multiple", async () => {
    await adapter.create(workspaceId, {
      name: "skill-a",
      description: "First skill",
      instructions: "Instructions A",
    });
    await adapter.create(workspaceId, {
      name: "skill-b",
      description: "Second skill",
      instructions: "Instructions B",
    });

    const list = await adapter.list(workspaceId);
    expect(list).toHaveLength(2);

    const names = list.map((s) => s.name);
    expect(names).toContain("skill-a");
    expect(names).toContain("skill-b");
  });

  it("update mutates", async () => {
    await adapter.create(workspaceId, {
      name: "updatable",
      description: "Original desc",
      instructions: "Original instructions",
    });

    const updated = await adapter.update(workspaceId, "updatable", {
      instructions: "New instructions",
    });
    expect(updated.instructions).toBe("New instructions");
    expect(updated.version).toBe("2");

    const fetched = await adapter.get(workspaceId, "updatable");
    expect(fetched?.instructions).toBe("New instructions");
    expect(fetched?.version).toBe("2");
  });

  it("invalidate is a no-op", () => {
    expect(() => adapter.invalidate(workspaceId)).not.toThrow();
  });

  it("history+rollback throw NotImplementedError", () => {
    expect(() => adapter.history(workspaceId, "any")).toThrow(NotImplementedError);
    expect(() => adapter.rollback(workspaceId, "any", "1")).toThrow(NotImplementedError);

    try {
      adapter.history(workspaceId, "any");
    } catch (e: unknown) {
      expect(e instanceof Error && e.name === "NotImplementedError").toBe(true);
    }
  });
});
