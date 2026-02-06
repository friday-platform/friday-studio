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

interface MockStore {
  objects: Map<string, { blob: string; metadata: CortexSkillMetadata }>;
  nextObjectId: number;
}

function createMockStore(): MockStore {
  return { objects: new Map(), nextObjectId: 1 };
}

/**
 * Create a mock fetch that simulates the Cortex API.
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
      const metadata = JSON.parse(init?.body as string) as CortexSkillMetadata;
      obj.metadata = metadata;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }

    // PUT /objects/:id - update blob
    const updateBlobMatch = path.match(/^\/objects\/([^/]+)$/);
    if (method === "PUT" && updateBlobMatch) {
      const objectId = updateBlobMatch[1];
      if (!objectId) {
        return Promise.resolve(new Response("Invalid object ID", { status: 400 }));
      }
      const obj = store.objects.get(objectId);
      if (!obj) {
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }
      obj.blob = (init?.body as string) ?? "";
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
          if (key === "metadata.skill_id" && obj.metadata.skill_id !== value) matches = false;
          if (key === "metadata.name" && obj.metadata.name !== value) matches = false;
          if (key === "metadata.workspace_id" && obj.metadata.workspace_id !== value)
            matches = false;
        }

        if (matches && obj.metadata.skill_id) {
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
  describe("create()", () => {
    it("uploads blob and sets metadata", async () => {
      const result = await adapter.create("user-1", {
        name: "test-skill",
        description: "A test skill",
        instructions: "Do the thing",
        workspaceId: "ws-123",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.name).toBe("test-skill");
      expect(result.data.description).toBe("A test skill");
      expect(result.data.instructions).toBe("Do the thing");
      expect(result.data.workspaceId).toBe("ws-123");
      expect(result.data.createdBy).toBe("user-1");
      expect(typeof result.data.id).toBe("string");
      expect(result.data.id.length > 0).toBe(true);

      // Verify store has the object
      expect(store.objects.size).toBe(1);
      const [entry] = store.objects.values();
      expect(entry?.blob).toBe("Do the thing");
      expect(entry?.metadata.name).toBe("test-skill");
    });

    it("sets timestamps on creation", async () => {
      const before = new Date();
      const result = await adapter.create("user-1", {
        name: "timestamped",
        description: "Test",
        instructions: "x",
        workspaceId: "ws-1",
      });
      const after = new Date();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.createdAt >= before).toBe(true);
      expect(result.data.createdAt <= after).toBe(true);
      expect(result.data.updatedAt.getTime()).toBe(result.data.createdAt.getTime());
    });
  });

  describe("getByName()", () => {
    it("queries by name and workspace_id", async () => {
      // Create a skill first
      const createResult = await adapter.create("user-1", {
        name: "findable",
        description: "Can be found",
        instructions: "Instructions here",
        workspaceId: "ws-abc",
      });
      expect(createResult.ok).toBe(true);

      // Query by name and workspace
      const result = await adapter.getByName("findable", "ws-abc");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data?.name).toBe("findable");
      expect(result.data?.description).toBe("Can be found");
      expect(result.data?.instructions).toBe("Instructions here");
      expect(result.data?.workspaceId).toBe("ws-abc");
    });

    it("returns null for non-existent skill", async () => {
      const result = await adapter.getByName("nonexistent", "ws-1");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toBe(null);
    });

    it("does not return skill from different workspace", async () => {
      await adapter.create("user-1", {
        name: "isolated",
        description: "Test",
        instructions: "x",
        workspaceId: "ws-a",
      });

      const result = await adapter.getByName("isolated", "ws-b");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toBe(null);
    });
  });

  describe("list()", () => {
    it("returns summaries for workspace", async () => {
      // Create skills in same workspace
      await adapter.create("user-1", {
        name: "skill-a",
        description: "First skill",
        instructions: "a",
        workspaceId: "ws-list",
      });
      await adapter.create("user-1", {
        name: "skill-b",
        description: "Second skill",
        instructions: "b",
        workspaceId: "ws-list",
      });
      // Create skill in different workspace
      await adapter.create("user-1", {
        name: "skill-c",
        description: "Other workspace",
        instructions: "c",
        workspaceId: "ws-other",
      });

      const result = await adapter.list("ws-list");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.length).toBe(2);

      const names = result.data.map((s) => s.name).sort();
      expect(names).toEqual(["skill-a", "skill-b"]);

      // Verify summaries have name and description only
      for (const summary of result.data) {
        expect(typeof summary.name).toBe("string");
        expect(typeof summary.description).toBe("string");
      }
    });

    it("returns empty array for workspace with no skills", async () => {
      const result = await adapter.list("empty-workspace");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([]);
    });
  });

  describe("update()", () => {
    it("creates new blob when instructions change", async () => {
      const createResult = await adapter.create("user-1", {
        name: "updatable",
        description: "Original",
        instructions: "Original instructions",
        workspaceId: "ws-1",
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = await adapter.update(createResult.data.id, {
        instructions: "Updated instructions",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.instructions).toBe("Updated instructions");
      expect(result.data.name).toBe("updatable"); // unchanged
    });

    it("updates metadata fields", async () => {
      const createResult = await adapter.create("user-1", {
        name: "meta-update",
        description: "Original desc",
        instructions: "x",
        workspaceId: "ws-1",
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = await adapter.update(createResult.data.id, {
        description: "Updated description",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.description).toBe("Updated description");
      expect(result.data.instructions).toBe("x"); // unchanged
    });

    it("updates updatedAt timestamp", async () => {
      const createResult = await adapter.create("user-1", {
        name: "timestamp-test",
        description: "Test",
        instructions: "x",
        workspaceId: "ws-1",
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const originalUpdatedAt = createResult.data.updatedAt;

      // Small delay to ensure timestamp differs
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updateResult = await adapter.update(createResult.data.id, { description: "Changed" });

      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;
      expect(updateResult.data.updatedAt > originalUpdatedAt).toBe(true);
    });

    it("returns error for non-existent skill", async () => {
      const result = await adapter.update("nonexistent-id", { description: "New" });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.includes("not found") || result.error.includes("Not found")).toBe(true);
    });
  });

  describe("delete()", () => {
    it("removes object from store", async () => {
      const createResult = await adapter.create("user-1", {
        name: "deletable",
        description: "Will be deleted",
        instructions: "x",
        workspaceId: "ws-1",
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      expect(store.objects.size).toBe(1);

      const deleteResult = await adapter.delete(createResult.data.id);
      expect(deleteResult.ok).toBe(true);

      // Verify object is gone
      expect(store.objects.size).toBe(0);
    });

    it("get returns null after delete", async () => {
      const createResult = await adapter.create("user-1", {
        name: "check-deleted",
        description: "Test",
        instructions: "x",
        workspaceId: "ws-1",
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      await adapter.delete(createResult.data.id);

      const getResult = await adapter.get(createResult.data.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.data).toBe(null);
    });

    it("succeeds even if skill does not exist", async () => {
      const result = await adapter.delete("nonexistent-id");
      expect(result.ok).toBe(true);
    });
  });

  describe("get()", () => {
    it("retrieves skill by id", async () => {
      const createResult = await adapter.create("user-1", {
        name: "get-by-id",
        description: "Test",
        instructions: "Content",
        workspaceId: "ws-1",
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = await adapter.get(createResult.data.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data?.name).toBe("get-by-id");
      expect(result.data?.instructions).toBe("Content");
    });

    it("returns null for non-existent id", async () => {
      const result = await adapter.get("nonexistent-id");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toBe(null);
    });
  });

  describe("authentication", () => {
    it("fails when ATLAS_KEY is not set", async () => {
      delete process.env.ATLAS_KEY;

      const result = await adapter.create("user-1", {
        name: "no-auth",
        description: "Test",
        instructions: "x",
        workspaceId: "ws-1",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.includes("ATLAS_KEY")).toBe(true);
    });
  });
});
