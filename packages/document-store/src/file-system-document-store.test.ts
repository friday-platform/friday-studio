import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileSystemDocumentStore } from "./file-system-document-store.ts";
import type { DocumentScope } from "./types.ts";

const scope: DocumentScope = { workspaceId: "test-ws" };

describe("FileSystemDocumentStore", () => {
  let store: FileSystemDocumentStore;
  let basePath: string;

  beforeEach(() => {
    basePath = join(tmpdir(), `docstore-test-${Date.now()}`);
    store = new FileSystemDocumentStore({ basePath });
  });

  afterEach(async () => {
    await rm(basePath, { recursive: true, force: true });
  });

  describe("readRaw with corrupted files", () => {
    test("returns null for corrupted JSON", async () => {
      const dir = join(basePath, "test-ws", "test-type");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "broken.json"), '{"data": "valid"} GARBAGE');

      // readRaw is protected — test through the public read method which calls it
      // When readRaw returns null for corrupted files, write() treats it as
      // a new document (no createdAt to preserve)
      const { z } = await import("zod");
      const schema = z.object({ value: z.string() });
      const result = await store.write(scope, "test-type", "broken", { value: "new" }, schema);
      expect(result.ok).toBe(true);
    });

    test("returns null for empty files", async () => {
      const dir = join(basePath, "test-ws", "test-type");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "empty.json"), "   ");

      const { z } = await import("zod");
      const schema = z.object({ value: z.string() });
      const result = await store.write(scope, "test-type", "empty", { value: "new" }, schema);
      expect(result.ok).toBe(true);
    });

    test("returns null for non-existent files", async () => {
      const { z } = await import("zod");
      const schema = z.object({ value: z.string() });
      const result = await store.write(scope, "test-type", "missing", { value: "new" }, schema);
      expect(result.ok).toBe(true);
    });
  });
});
