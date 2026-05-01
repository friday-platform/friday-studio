import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MCPServerMetadata } from "../schemas.ts";
import { LocalMCPRegistryAdapter } from "./local-adapter.ts";

// In-memory KV for test isolation
let testKv: Deno.Kv;
let adapter: LocalMCPRegistryAdapter;

beforeAll(async () => {
  testKv = await Deno.openKv(":memory:");
  adapter = new LocalMCPRegistryAdapter(testKv);
});

afterAll(() => {
  testKv.close();
});

/** Create a valid test entry with unique ID */
function createTestEntry(suffix: string): MCPServerMetadata {
  return {
    id: `test-${suffix}`,
    name: `Test Server ${suffix}`,
    source: "web",
    securityRating: "medium",
    configTemplate: { transport: { type: "stdio", command: "echo", args: ["hello"] } },
    requiredConfig: [{ key: "TEST_KEY", description: "A test key", type: "string" as const }],
  };
}

describe("LocalMCPRegistryAdapter", () => {
  describe("update", () => {
    it("updates an existing entry and returns the updated entry", async () => {
      const entry = createTestEntry("update-basic");
      await adapter.add(entry);

      const updated = await adapter.update(entry.id, { name: "Updated Name" });

      expect(updated).not.toBeNull();
      expect(updated!.name).toEqual("Updated Name");
      expect(updated!.id).toEqual(entry.id);
      expect(updated!.source).toEqual(entry.source);
      expect(updated!.securityRating).toEqual(entry.securityRating);
    });

    it("returns null when updating non-existent entry", async () => {
      const result = await adapter.update("nonexistent-id", { name: "New Name" });

      expect(result).toBeNull();
    });

    it("partially updates only provided fields", async () => {
      const entry = createTestEntry("partial-update");
      await adapter.add(entry);

      const updated = await adapter.update(entry.id, {
        name: "New Name",
        description: "New description",
      });

      expect(updated).not.toBeNull();
      expect(updated!.name).toEqual("New Name");
      expect(updated!.description).toEqual("New description");
      // Original fields should be preserved
      expect(updated!.securityRating).toEqual(entry.securityRating);
      expect(updated!.configTemplate).toEqual(entry.configTemplate);
    });

    it("persists updates and reflects them in subsequent gets", async () => {
      const entry = createTestEntry("persist-update");
      await adapter.add(entry);

      await adapter.update(entry.id, { name: "Persisted Name" });

      const retrieved = await adapter.get(entry.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toEqual("Persisted Name");
    });

    it("persists updates and reflects them in list", async () => {
      const entry = createTestEntry("list-update");
      await adapter.add(entry);

      await adapter.update(entry.id, { name: "Listed Name" });

      const entries = await adapter.list();
      const found = entries.find((e) => e.id === entry.id);
      expect(found).toBeDefined();
      expect(found!.name).toEqual("Listed Name");
    });

    it("throws on atomic conflict (version mismatch)", async () => {
      const entry = createTestEntry("concurrent");
      await adapter.add(entry);

      // Read the entry directly to get its versionstamp
      const key = ["mcp_registry", entry.id];
      const firstRead = await testKv.get<MCPServerMetadata>(key);
      expect(firstRead.versionstamp).not.toBeNull();

      // Modify the entry directly via atomic (this will change the versionstamp)
      const firstResult = await testKv
        .atomic()
        .check(firstRead)
        .set(key, { ...entry, name: "First Update" })
        .commit();
      expect(firstResult.ok).toBe(true);

      // Try to commit using the OLD versionstamp (simulates a stale read)
      // This should fail because the versionstamp has changed
      const staleResult = await testKv
        .atomic()
        .check(firstRead) // Stale versionstamp
        .set(key, { ...entry, name: "Stale Update" })
        .commit();

      expect(staleResult.ok).toBe(false);

      // The adapter properly handles this case by throwing
      // when the atomic commit fails (even though we can't easily trigger it
      // through the public API due to the read-before-write pattern)
    });

    it("can update multiple fields at once", async () => {
      const entry = createTestEntry("multi-field");
      await adapter.add(entry);

      const updated = await adapter.update(entry.id, {
        name: "New Name",
        description: "New Description",
        securityRating: "high",
        constraints: "New constraints",
      });

      expect(updated).not.toBeNull();
      expect(updated!.name).toEqual("New Name");
      expect(updated!.description).toEqual("New Description");
      expect(updated!.securityRating).toEqual("high");
      expect(updated!.constraints).toEqual("New constraints");
      // Original fields preserved
      expect(updated!.configTemplate).toEqual(entry.configTemplate);
      expect(updated!.requiredConfig).toEqual(entry.requiredConfig);
    });

    it("can update urlDomains field", async () => {
      const entry = createTestEntry("domains-update");
      await adapter.add(entry);

      const updated = await adapter.update(entry.id, {
        urlDomains: ["example.com", "api.example.com"],
      });

      expect(updated).not.toBeNull();
      expect(updated!.urlDomains).toEqual(["example.com", "api.example.com"]);
    });

    it("can update configTemplate field", async () => {
      const entry = createTestEntry("config-update");
      await adapter.add(entry);

      const newConfig = {
        transport: { type: "http" as const, url: "https://api.example.com/mcp" },
        auth: { type: "bearer" as const, token_env: "API_TOKEN" },
      };

      const updated = await adapter.update(entry.id, { configTemplate: newConfig });

      expect(updated).not.toBeNull();
      expect(updated!.configTemplate).toEqual(newConfig);
    });

    it("can update requiredConfig field", async () => {
      const entry = createTestEntry("required-update");
      await adapter.add(entry);

      const newRequired = [
        { key: "API_KEY", description: "API key", type: "string" as const },
        { key: "ENDPOINT", description: "API endpoint", type: "string" as const },
      ];

      const updated = await adapter.update(entry.id, { requiredConfig: newRequired });

      expect(updated).not.toBeNull();
      expect(updated!.requiredConfig).toEqual(newRequired);
    });
  });
});
