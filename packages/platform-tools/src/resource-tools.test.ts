import type { ResourceStorageAdapter } from "@atlas/ledger";
import { describe, expect, it, vi } from "vitest";
import {
  createResourceLinkRefTool,
  createResourceReadTool,
  createResourceSaveTool,
  createResourceWriteTool,
} from "./resource-tools.ts";

/** AI SDK types execute as optional, but our tool factories always provide it */
const toolCallCtx = { toolCallId: "test", messages: [] as [] };

/** Extracts the execute function from a tool, throwing if absent. */
function getExecute<I, O>(tool: {
  execute?: (input: I, ctx: typeof toolCallCtx) => O | PromiseLike<O> | AsyncIterable<O>;
}) {
  if (!tool.execute) throw new Error("tool factory must provide execute");
  return tool.execute;
}

/**
 * @description Builds a stub ResourceStorageAdapter with all methods throwing
 * "not implemented". Caller overrides specific methods per test.
 */
function stubAdapter(overrides: Partial<ResourceStorageAdapter> = {}): ResourceStorageAdapter {
  const notImpl = () => Promise.reject(new Error("not implemented"));
  return {
    init: notImpl,
    destroy: notImpl,
    provision: notImpl,
    query: notImpl,
    mutate: notImpl,
    publish: notImpl,
    replaceVersion: notImpl,
    listResources: notImpl,
    getResource: notImpl,
    deleteResource: notImpl,
    linkRef: notImpl,
    resetDraft: notImpl,
    publishAllDirty: notImpl,
    getSkill: notImpl,
    ...overrides,
  };
}

describe("resource tool factories", () => {
  const workspaceId = "ws-tools-test";

  describe("createResourceReadTool", () => {
    it("passes slug, sql, and params to adapter.query", async () => {
      const query = vi
        .fn<ResourceStorageAdapter["query"]>()
        .mockResolvedValue({ rows: [{ name: "A" }], rowCount: 1 });
      const adapter = stubAdapter({ query });
      const readTool = createResourceReadTool(adapter, workspaceId);

      const result = await getExecute(readTool)(
        { slug: "items", sql: "SELECT j.value FROM draft, json_each(draft.data) j", params: [1] },
        toolCallCtx,
      );

      expect(query).toHaveBeenCalledWith(
        workspaceId,
        "items",
        "SELECT j.value FROM draft, json_each(draft.data) j",
        [1],
      );
      expect(result).toEqual({ rows: [{ name: "A" }], rowCount: 1 });
    });

    it("returns error object when adapter throws", async () => {
      const adapter = stubAdapter({
        query: () => Promise.reject(new Error("no such resource: bad_slug")),
      });
      const readTool = createResourceReadTool(adapter, workspaceId);

      const result = await getExecute(readTool)(
        { slug: "bad_slug", sql: "SELECT * FROM draft" },
        toolCallCtx,
      );

      expect(result).toEqual({ error: "no such resource: bad_slug" });
    });
  });

  describe("createResourceWriteTool", () => {
    it("passes slug, sql, and params to adapter.mutate", async () => {
      const mutate = vi.fn<ResourceStorageAdapter["mutate"]>().mockResolvedValue({ applied: true });
      const adapter = stubAdapter({ mutate });
      const writeTool = createResourceWriteTool(adapter, workspaceId);

      const result = await getExecute(writeTool)(
        {
          slug: "items",
          sql: "SELECT json_insert(draft.data, '$[#]', json_object('item', 'eggs')) FROM draft",
        },
        toolCallCtx,
      );

      expect(mutate).toHaveBeenCalledWith(
        workspaceId,
        "items",
        "SELECT json_insert(draft.data, '$[#]', json_object('item', 'eggs')) FROM draft",
        undefined,
      );
      expect(result).toEqual({ applied: true });
    });

    it("returns error object when adapter throws", async () => {
      const adapter = stubAdapter({
        mutate: () => Promise.reject(new Error("read-only resource")),
      });
      const writeTool = createResourceWriteTool(adapter, workspaceId);

      const result = await getExecute(writeTool)(
        { slug: "readonly_res", sql: "SELECT 'new data' FROM draft" },
        toolCallCtx,
      );

      expect(result).toEqual({ error: "read-only resource" });
    });
  });

  describe("createResourceSaveTool", () => {
    it("passes slug to adapter.publish", async () => {
      const publish = vi.fn<ResourceStorageAdapter["publish"]>().mockResolvedValue({ version: 2 });
      const adapter = stubAdapter({ publish });
      const saveTool = createResourceSaveTool(adapter, workspaceId);

      const result = await getExecute(saveTool)({ slug: "items" }, toolCallCtx);

      expect(publish).toHaveBeenCalledWith(workspaceId, "items");
      expect(result).toEqual({ version: 2 });
    });

    it("returns null version when draft is clean", async () => {
      const adapter = stubAdapter({ publish: () => Promise.resolve({ version: null }) });
      const saveTool = createResourceSaveTool(adapter, workspaceId);

      const result = await getExecute(saveTool)({ slug: "items" }, toolCallCtx);

      expect(result).toEqual({ version: null });
    });

    it("returns error object when adapter throws", async () => {
      const adapter = stubAdapter({
        publish: () => Promise.reject(new Error("resource not found")),
      });
      const saveTool = createResourceSaveTool(adapter, workspaceId);

      const result = await getExecute(saveTool)({ slug: "missing" }, toolCallCtx);

      expect(result).toEqual({ error: "resource not found" });
    });
  });

  describe("createResourceLinkRefTool", () => {
    it("passes slug and ref to adapter.linkRef", async () => {
      const linkRef = vi
        .fn<ResourceStorageAdapter["linkRef"]>()
        .mockResolvedValue({
          id: "ver-1",
          resourceId: "res-1",
          userId: "user-1",
          version: 2,
          schema: {},
          data: { ref: "https://docs.google.com/spreadsheets/d/abc123" },
          dirty: false,
          draftVersion: 0,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      const adapter = stubAdapter({ linkRef });
      const linkTool = createResourceLinkRefTool(adapter, workspaceId);

      const result = await getExecute(linkTool)(
        { slug: "my_sheet", ref: "https://docs.google.com/spreadsheets/d/abc123" },
        toolCallCtx,
      );

      expect(linkRef).toHaveBeenCalledWith(
        workspaceId,
        "my_sheet",
        "https://docs.google.com/spreadsheets/d/abc123",
      );
      expect(result).toHaveProperty("version", 2);
    });

    it("returns error object for non-existent slug", async () => {
      const adapter = stubAdapter({
        linkRef: () => Promise.reject(new Error("resource not found: nonexistent")),
      });
      const linkTool = createResourceLinkRefTool(adapter, workspaceId);

      const result = await getExecute(linkTool)(
        { slug: "nonexistent", ref: "https://example.com" },
        toolCallCtx,
      );

      expect(result).toEqual({ error: "resource not found: nonexistent" });
    });
  });
});
