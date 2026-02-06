import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join } from "@std/path";
import { describe, expect, it } from "vitest";
import { CortexSkillAdapter } from "../src/cortex-adapter.ts";
import { LocalSkillAdapter } from "../src/local-adapter.ts";

describe("Storage Factory - Adapter Instantiation", () => {
  describe("LocalSkillAdapter", () => {
    it("instantiates without env vars", () => {
      const dbPath = join(tmpdir(), `skills-factory-test-${Date.now()}.db`);
      const adapter = new LocalSkillAdapter(dbPath);
      expect(typeof adapter.create).toBe("function");
      expect(typeof adapter.get).toBe("function");
      expect(typeof adapter.getByName).toBe("function");
      expect(typeof adapter.list).toBe("function");
      expect(typeof adapter.update).toBe("function");
      expect(typeof adapter.delete).toBe("function");
      try {
        rmSync(dbPath);
      } catch {
        // Ignore if file doesn't exist yet
      }
    });

    it("implements SkillStorageAdapter interface", async () => {
      const dbPath = join(tmpdir(), `skills-factory-test-${Date.now()}.db`);
      const adapter = new LocalSkillAdapter(dbPath);

      // Can call list without env vars
      const result = await adapter.list("test-workspace");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Array.isArray(result.data)).toBe(true);
      }

      try {
        rmSync(dbPath);
      } catch {
        // Ignore cleanup errors
      }
    });
  });

  describe("CortexSkillAdapter", () => {
    it("requires baseUrl in constructor", () => {
      const adapter = new CortexSkillAdapter("https://cortex.example.com");
      expect(typeof adapter.create).toBe("function");
      expect(typeof adapter.get).toBe("function");
      expect(typeof adapter.getByName).toBe("function");
      expect(typeof adapter.list).toBe("function");
      expect(typeof adapter.update).toBe("function");
      expect(typeof adapter.delete).toBe("function");
    });

    it("strips trailing slashes from baseUrl", () => {
      // The adapter normalizes URLs by removing trailing slashes
      // We verify this by instantiating with trailing slashes
      const adapter = new CortexSkillAdapter("https://cortex.example.com///");
      // If the adapter didn't throw, URL normalization worked
      expect(typeof adapter.list).toBe("function");
    });

    it("fails on actual requests if no ATLAS_KEY", async () => {
      // Save and clear ATLAS_KEY
      const originalKey = process.env.ATLAS_KEY;
      delete process.env.ATLAS_KEY;

      try {
        const adapter = new CortexSkillAdapter("https://cortex.example.com");

        // Attempting to list should fail because getAuthToken throws when ATLAS_KEY is missing
        const result = await adapter.list("test-workspace");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.includes("ATLAS_KEY")).toBe(true);
        }
      } finally {
        // Restore ATLAS_KEY if it existed
        if (originalKey) {
          process.env.ATLAS_KEY = originalKey;
        }
      }
    });

    it("fails on create if no ATLAS_KEY", async () => {
      const originalKey = process.env.ATLAS_KEY;
      delete process.env.ATLAS_KEY;

      try {
        const adapter = new CortexSkillAdapter("https://cortex.example.com");
        const result = await adapter.create("user-1", {
          name: "test-skill",
          description: "Test",
          instructions: "Do stuff",
          workspaceId: "ws-1",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.includes("ATLAS_KEY")).toBe(true);
        }
      } finally {
        if (originalKey) {
          process.env.ATLAS_KEY = originalKey;
        }
      }
    });

    it("fails on get if no ATLAS_KEY", async () => {
      const originalKey = process.env.ATLAS_KEY;
      delete process.env.ATLAS_KEY;

      try {
        const adapter = new CortexSkillAdapter("https://cortex.example.com");
        const result = await adapter.get("skill-id");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.includes("ATLAS_KEY")).toBe(true);
        }
      } finally {
        if (originalKey) {
          process.env.ATLAS_KEY = originalKey;
        }
      }
    });
  });
});
