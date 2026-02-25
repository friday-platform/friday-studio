import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  describe("publish", () => {
    it("publishes a skill with version 1", async () => {
      const result = await adapter.publish("atlas", "code-review", "user-1", {
        description: "Reviews code",
        instructions: "Review the code.",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.version).toBe(1);
      expect(result.data.id).toBeTruthy();
    });

    it("auto-increments version on republish", async () => {
      await adapter.publish("atlas", "code-review", "user-1", {
        description: "v1",
        instructions: "First version.",
      });
      const v2 = await adapter.publish("atlas", "code-review", "user-1", {
        description: "v2",
        instructions: "Second version.",
      });
      expect(v2.ok).toBe(true);
      if (!v2.ok) return;
      expect(v2.data.version).toBe(2);

      const v3 = await adapter.publish("atlas", "code-review", "user-1", {
        description: "v3",
        instructions: "Third version.",
      });
      expect(v3.ok).toBe(true);
      if (!v3.ok) return;
      expect(v3.data.version).toBe(3);
    });

    it("versions are independent per namespace+name", async () => {
      await adapter.publish("atlas", "skill-a", "user-1", { description: "A", instructions: "." });
      const b = await adapter.publish("atlas", "skill-b", "user-1", {
        description: "B",
        instructions: ".",
      });
      expect(b.ok).toBe(true);
      if (!b.ok) return;
      expect(b.data.version).toBe(1);
    });

    it("stores frontmatter when provided", async () => {
      await adapter.publish("atlas", "with-fm", "user-1", {
        description: "Has frontmatter",
        instructions: "Do things.",
        frontmatter: { "allowed-tools": "Read, Grep", context: "fork" },
      });
      const result = await adapter.get("atlas", "with-fm");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data?.frontmatter["allowed-tools"]).toBe("Read, Grep");
    });

    it("stores archive when provided", async () => {
      const archive = new Uint8Array([1, 2, 3, 4]);
      await adapter.publish("atlas", "with-archive", "user-1", {
        description: "Has archive",
        instructions: ".",
        archive,
      });
      const result = await adapter.get("atlas", "with-archive");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data?.archive).toEqual(archive);
    });
  });

  describe("get", () => {
    it("returns latest version when version omitted", async () => {
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v1",
        instructions: "First.",
      });
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v2",
        instructions: "Second.",
      });
      const result = await adapter.get("atlas", "my-skill");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data?.version).toBe(2);
      expect(result.data?.description).toBe("v2");
    });

    it("returns specific version when provided", async () => {
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v1",
        instructions: "First.",
      });
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v2",
        instructions: "Second.",
      });
      const result = await adapter.get("atlas", "my-skill", 1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data?.version).toBe(1);
      expect(result.data?.description).toBe("v1");
    });

    it("returns null for nonexistent skill", async () => {
      const result = await adapter.get("atlas", "missing");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toBe(null);
    });

    it("returns null for nonexistent version", async () => {
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v1",
        instructions: ".",
      });
      const result = await adapter.get("atlas", "my-skill", 99);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toBe(null);
    });
  });

  describe("list", () => {
    it("returns one summary per namespace+name with latest version", async () => {
      await adapter.publish("atlas", "skill-a", "user-1", {
        description: "A v1",
        instructions: ".",
      });
      await adapter.publish("atlas", "skill-a", "user-1", {
        description: "A v2",
        instructions: ".",
      });
      await adapter.publish("atlas", "skill-b", "user-1", { description: "B", instructions: "." });
      const result = await adapter.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.length).toBe(2);
      const a = result.data.find((s) => s.name === "skill-a");
      expect(a?.latestVersion).toBe(2);
      expect(a?.description).toBe("A v2");
    });

    it("filters by namespace", async () => {
      await adapter.publish("atlas", "skill-a", "user-1", { description: "A", instructions: "." });
      await adapter.publish("acme", "skill-b", "user-1", { description: "B", instructions: "." });
      const result = await adapter.list("atlas");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.length).toBe(1);
      expect(result.data[0]?.namespace).toBe("atlas");
    });

    it("filters by query text", async () => {
      await adapter.publish("atlas", "code-review", "user-1", {
        description: "Reviews code for issues",
        instructions: ".",
      });
      await adapter.publish("atlas", "deploy", "user-1", {
        description: "Deploys stuff",
        instructions: ".",
      });
      const result = await adapter.list(undefined, "review");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.length).toBe(1);
      expect(result.data[0]?.name).toBe("code-review");
    });
  });

  describe("listVersions", () => {
    it("returns all versions sorted descending", async () => {
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v1",
        instructions: ".",
      });
      await adapter.publish("atlas", "my-skill", "user-2", {
        description: "v2",
        instructions: ".",
      });
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v3",
        instructions: ".",
      });
      const result = await adapter.listVersions("atlas", "my-skill");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.length).toBe(3);
      expect(result.data[0]?.version).toBe(3);
      expect(result.data[1]?.version).toBe(2);
      expect(result.data[2]?.version).toBe(1);
      expect(result.data[1]?.createdBy).toBe("user-2");
    });

    it("returns empty array for nonexistent skill", async () => {
      const result = await adapter.listVersions("atlas", "missing");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([]);
    });
  });

  describe("deleteVersion", () => {
    it("removes a specific version", async () => {
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v1",
        instructions: ".",
      });
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v2",
        instructions: ".",
      });

      const del = await adapter.deleteVersion("atlas", "my-skill", 1);
      expect(del.ok).toBe(true);

      const v1 = await adapter.get("atlas", "my-skill", 1);
      expect(v1.ok).toBe(true);
      if (!v1.ok) return;
      expect(v1.data).toBe(null);

      // v2 still exists
      const v2 = await adapter.get("atlas", "my-skill", 2);
      expect(v2.ok).toBe(true);
      if (!v2.ok) return;
      expect(v2.data?.version).toBe(2);
    });

    it("does not error when deleting nonexistent version", async () => {
      const result = await adapter.deleteVersion("atlas", "missing", 1);
      expect(result.ok).toBe(true);
    });
  });
});
