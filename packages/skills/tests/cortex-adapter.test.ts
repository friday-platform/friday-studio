import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CortexObject,
  CortexSkillAdapter,
  type CortexSkillMetadata,
} from "../src/cortex-adapter.ts";

// =============================================================================
// Mock Fetch Infrastructure
// =============================================================================

const BASE_URL = "https://cortex.example.com";

interface StoredObject {
  blob: string;
  metadata: CortexSkillMetadata;
}

interface MockStore {
  objects: Map<string, StoredObject>;
  nextObjectId: number;
}

function createMockStore(): MockStore {
  return { objects: new Map(), nextObjectId: 1 };
}

/**
 * Create a mock fetch that simulates the Cortex API.
 * Supports metadata queries with `metadata.key=value` filtering.
 */
function createMockFetch(store: MockStore): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const path = url.replace(BASE_URL, "");

    // POST /objects - upload blob
    if (method === "POST" && path === "/objects") {
      const objectId = `obj-${store.nextObjectId++}`;
      const blob = (init?.body as string) ?? "";
      store.objects.set(objectId, { blob, metadata: {} as CortexSkillMetadata });
      return Promise.resolve(
        new Response(JSON.stringify({ id: objectId }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    // POST /objects/:id/metadata - set metadata
    const metadataMatch = path.match(/^\/objects\/([^/]+)\/metadata$/);
    if (method === "POST" && metadataMatch) {
      const objectId = metadataMatch[1];
      if (!objectId) {
        return Promise.resolve(new Response("Invalid object ID", { status: 400 }));
      }
      const obj = store.objects.get(objectId);
      if (!obj) {
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }
      obj.metadata = JSON.parse(init?.body as string) as CortexSkillMetadata;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }

    // DELETE /objects/:id - delete object
    const deleteMatch = path.match(/^\/objects\/([^/]+)$/);
    if (method === "DELETE" && deleteMatch) {
      const objectId = deleteMatch[1];
      if (objectId) {
        store.objects.delete(objectId);
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }

    // GET /objects/:id - get blob content
    const getBlobMatch = path.match(/^\/objects\/([^/]+)$/);
    if (method === "GET" && getBlobMatch && !path.includes("?")) {
      const objectId = getBlobMatch[1];
      if (!objectId) {
        return Promise.resolve(new Response("Invalid object ID", { status: 400 }));
      }
      const obj = store.objects.get(objectId);
      if (!obj) {
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }
      return Promise.resolve(new Response(obj.blob, { status: 200 }));
    }

    // GET /objects?metadata.* - query by metadata
    if (method === "GET" && path.startsWith("/objects?")) {
      const queryString = path.split("?")[1] ?? "";
      const params = new URLSearchParams(queryString);

      const results: CortexObject[] = [];
      for (const [id, obj] of store.objects.entries()) {
        let matches = true;

        for (const [key, value] of params.entries()) {
          if (!key.startsWith("metadata.")) continue;
          const field = key.replace("metadata.", "") as keyof CortexSkillMetadata;
          const metaValue = obj.metadata[field];
          if (metaValue === undefined) {
            matches = false;
          } else if (typeof metaValue === "number") {
            if (metaValue !== Number(value)) matches = false;
          } else if (String(metaValue) !== value) {
            matches = false;
          }
        }

        // Only include objects that have been fully initialized (have metadata set)
        if (matches && obj.metadata.type) {
          results.push({ id, metadata: obj.metadata });
        }
      }

      return Promise.resolve(
        new Response(JSON.stringify(results), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    return Promise.resolve(
      new Response(`Mock not configured for: ${method} ${path}`, { status: 500 }),
    );
  };
}

// =============================================================================
// Test Setup
// =============================================================================

let originalFetch: typeof fetch;
let originalAtlasKey: string | undefined;
let store: MockStore;
let adapter: CortexSkillAdapter;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalAtlasKey = process.env.ATLAS_KEY;
  process.env.ATLAS_KEY = "test-atlas-key";

  store = createMockStore();
  globalThis.fetch = createMockFetch(store);
  adapter = new CortexSkillAdapter(BASE_URL);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAtlasKey === undefined) {
    delete process.env.ATLAS_KEY;
  } else {
    process.env.ATLAS_KEY = originalAtlasKey;
  }
});

// =============================================================================
// Tests
// =============================================================================

describe("CortexSkillAdapter", () => {
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

    it("stores archive as separate linked blob", async () => {
      const archive = new Uint8Array([1, 2, 3, 4]);
      await adapter.publish("atlas", "with-archive", "user-1", {
        description: "Has archive",
        instructions: ".",
        archive,
      });

      // Primary blob + archive blob = 2 objects with metadata.type set
      const skillObjects = [...store.objects.values()].filter((o) => o.metadata.type);
      expect(skillObjects.length).toBe(2);

      const primary = skillObjects.find((o) => o.metadata.type === "skill");
      const archiveObj = skillObjects.find((o) => o.metadata.type === "archive");
      expect(primary).toBeTruthy();
      expect(archiveObj).toBeTruthy();
      expect(primary?.metadata.skill_id).toBe(archiveObj?.metadata.skill_id);

      // Verify archive round-trips through get()
      const result = await adapter.get("atlas", "with-archive");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data?.archive).toEqual(archive);
    });

    it("sets is_latest=true on first publish", async () => {
      await adapter.publish("atlas", "new-skill", "user-1", {
        description: "First",
        instructions: ".",
      });
      const skillObjs = [...store.objects.values()].filter((o) => o.metadata.type === "skill");
      expect(skillObjs.length).toBe(1);
      expect(skillObjs[0]?.metadata.is_latest).toBe(true);
    });

    it("swaps is_latest on republish", async () => {
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v1",
        instructions: "First.",
      });
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v2",
        instructions: "Second.",
      });

      const skillObjs = [...store.objects.values()].filter((o) => o.metadata.type === "skill");
      expect(skillObjs.length).toBe(2);

      const v1 = skillObjs.find((o) => o.metadata.version === 1);
      const v2 = skillObjs.find((o) => o.metadata.version === 2);
      expect(v1?.metadata.is_latest).toBe(false);
      expect(v2?.metadata.is_latest).toBe(true);
    });

    it("sets is_latest=false on archive blobs", async () => {
      await adapter.publish("atlas", "with-archive", "user-1", {
        description: "Has archive",
        instructions: ".",
        archive: new Uint8Array([1, 2, 3]),
      });
      const archiveObjs = [...store.objects.values()].filter((o) => o.metadata.type === "archive");
      expect(archiveObjs.length).toBe(1);
      expect(archiveObjs[0]?.metadata.is_latest).toBe(false);
    });

    it("handles archives larger than 65KB without crashing", async () => {
      // String.fromCharCode(...arr) crashes when arr exceeds ~65K elements
      const size = 100_000;
      const archive = new Uint8Array(size);
      for (let i = 0; i < size; i++) archive[i] = i % 256;

      const result = await adapter.publish("atlas", "big-archive", "user-1", {
        description: "Large archive",
        instructions: ".",
        archive,
      });
      expect(result.ok).toBe(true);

      const loaded = await adapter.get("atlas", "big-archive");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.data?.archive).toEqual(archive);
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

    it("falls back to version ordering when is_latest is missing", async () => {
      // Simulate race window: publish two versions then manually clear is_latest
      await adapter.publish("atlas", "race-skill", "user-1", {
        description: "v1",
        instructions: "First.",
      });
      await adapter.publish("atlas", "race-skill", "user-1", {
        description: "v2",
        instructions: "Second.",
      });

      // Clear is_latest on all skill objects (simulates mid-swap state)
      for (const obj of store.objects.values()) {
        if (obj.metadata.type === "skill") {
          obj.metadata.is_latest = false;
        }
      }

      const result = await adapter.get("atlas", "race-skill");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data?.version).toBe(2);
      expect(result.data?.description).toBe("v2");
    });

    it("populates all skill fields", async () => {
      await adapter.publish("atlas", "full-skill", "user-1", {
        description: "Full skill",
        instructions: "Do all the things.",
        frontmatter: { context: "fork" },
      });
      const result = await adapter.get("atlas", "full-skill");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const skill = result.data;
      expect(skill).not.toBe(null);
      if (!skill) return;

      expect(skill.namespace).toBe("atlas");
      expect(skill.name).toBe("full-skill");
      expect(skill.version).toBe(1);
      expect(skill.description).toBe("Full skill");
      expect(skill.instructions).toBe("Do all the things.");
      expect(skill.frontmatter).toEqual({ context: "fork" });
      expect(skill.createdBy).toBe("user-1");
      expect(skill.createdAt).toBeInstanceOf(Date);
      expect(skill.archive).toBe(null);
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

    it("returns empty array when no skills exist", async () => {
      const result = await adapter.list("empty-ns");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([]);
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
    it("removes both primary and archive blobs", async () => {
      const archive = new Uint8Array([1, 2, 3]);
      await adapter.publish("atlas", "my-skill", "user-1", {
        description: "v1",
        instructions: ".",
        archive,
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

  describe("authentication", () => {
    it("fails when ATLAS_KEY is not set", async () => {
      delete process.env.ATLAS_KEY;

      const result = await adapter.publish("atlas", "no-auth", "user-1", {
        description: "Test",
        instructions: "x",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.includes("ATLAS_KEY")).toBe(true);
    });
  });
});
