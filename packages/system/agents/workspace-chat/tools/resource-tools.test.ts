import type { ResourceStorageAdapter } from "@atlas/ledger";
import type { ResourceEntry } from "@atlas/resources";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createResourceChatTools } from "./resource-tools.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub ToolExecutionOptions for direct execute calls. */
const TOOL_CALL_OPTS = { toolCallId: "test-call", messages: [] as never[] };

/** Extract a tool from AtlasTools with a runtime guard (avoids TS2722 on undefined). */
function getTool(tools: Record<string, unknown>, name: string) {
  const t = tools[name];
  if (
    !t ||
    typeof t !== "object" ||
    !("execute" in t) ||
    typeof (t as Record<string, unknown>).execute !== "function"
  ) {
    throw new Error(`Tool "${name}" not found or missing execute`);
  }
  return t as { execute: (input: Record<string, unknown>, opts: unknown) => Promise<unknown> };
}

function makeAdapter(overrides: Partial<ResourceStorageAdapter> = {}): ResourceStorageAdapter {
  return {
    init: vi.fn(),
    destroy: vi.fn(),
    provision: vi.fn(),
    query: vi.fn(),
    mutate: vi.fn(),
    publish: vi.fn(),
    replaceVersion: vi.fn(),
    listResources: vi.fn(),
    getResource: vi.fn(),
    deleteResource: vi.fn(),
    linkRef: vi.fn(),
    resetDraft: vi.fn(),
    publishAllDirty: vi.fn(),
    getSkill: vi.fn(),
    ...overrides,
  } satisfies Record<keyof ResourceStorageAdapter, unknown>;
}

function makeMetadata(entries: ResourceEntry[]): Map<string, ResourceEntry> {
  return new Map(entries.map((e) => [e.slug, e]));
}

const DOCUMENT_ENTRY: ResourceEntry = {
  type: "document",
  slug: "food-log",
  name: "Food Log",
  description: "Daily food entries",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const EXTERNAL_ENTRY: ResourceEntry = {
  type: "external_ref",
  slug: "notion-meals",
  name: "Notion Meals",
  description: "Meals in Notion",
  provider: "Notion",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const ARTIFACT_ENTRY: ResourceEntry = {
  type: "artifact_ref",
  slug: "sales-data",
  name: "Sales Data",
  description: "Q1 sales report",
  artifactId: "art-123",
  artifactType: "file",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createResourceChatTools", () => {
  it("returns resource_read and resource_write tools", () => {
    const tools = createResourceChatTools(makeAdapter(), makeMetadata([]), "ws-1");
    expect(Object.keys(tools).sort()).toEqual(["resource_read", "resource_write"]);
  });
});

describe("resource_read", () => {
  let adapter: ResourceStorageAdapter;

  beforeEach(() => {
    adapter = makeAdapter({
      query: vi
        .fn<ResourceStorageAdapter["query"]>()
        .mockResolvedValue({ rows: [{ id: 1, name: "eggs" }], rowCount: 1 }),
    });
  });

  it("forwards document resource queries to adapter.query()", async () => {
    const tools = createResourceChatTools(adapter, makeMetadata([DOCUMENT_ENTRY]), "ws-1");
    const result = await getTool(tools, "resource_read").execute(
      { slug: "food-log", sql: "SELECT * FROM draft", params: [] },
      TOOL_CALL_OPTS,
    );

    expect(adapter.query).toHaveBeenCalledWith("ws-1", "food-log", "SELECT * FROM draft", []);
    expect(result).toEqual({ rows: [{ id: 1, name: "eggs" }], rowCount: 1 });
  });

  it("returns guidance error for external_ref resources", async () => {
    const tools = createResourceChatTools(adapter, makeMetadata([EXTERNAL_ENTRY]), "ws-1");
    const result = await getTool(tools, "resource_read").execute(
      { slug: "notion-meals", sql: "SELECT * FROM draft" },
      TOOL_CALL_OPTS,
    );

    expect(adapter.query).not.toHaveBeenCalled();
    expect(result).toEqual({
      error:
        '"notion-meals" is an external resource (Notion). Use delegate or an agent_<id> tool to interact with it.',
      hint: "Example: delegate({ goal: '...' })",
    });
  });

  it("returns guidance error for artifact_ref resources", async () => {
    const tools = createResourceChatTools(adapter, makeMetadata([ARTIFACT_ENTRY]), "ws-1");
    const result = await getTool(tools, "resource_read").execute(
      { slug: "sales-data", sql: "SELECT * FROM draft" },
      TOOL_CALL_OPTS,
    );

    expect(adapter.query).not.toHaveBeenCalled();
    expect(result).toEqual({
      error:
        '"sales-data" is a read-only file. Use artifacts_get to access it, or agent_data-analyst for queries.',
    });
  });

  it("forwards unknown slugs to Ledger (handles mid-conversation creation)", async () => {
    const tools = createResourceChatTools(adapter, makeMetadata([]), "ws-1");
    await getTool(tools, "resource_read").execute(
      { slug: "new-resource", sql: "SELECT * FROM draft" },
      TOOL_CALL_OPTS,
    );

    expect(adapter.query).toHaveBeenCalledWith(
      "ws-1",
      "new-resource",
      "SELECT * FROM draft",
      undefined,
    );
  });

  it("surfaces Ledger errors as { error } instead of throwing", async () => {
    adapter = makeAdapter({
      query: vi
        .fn<ResourceStorageAdapter["query"]>()
        .mockRejectedValue(new Error("Resource not found")),
    });
    const tools = createResourceChatTools(adapter, makeMetadata([DOCUMENT_ENTRY]), "ws-1");
    const result = await getTool(tools, "resource_read").execute(
      { slug: "food-log", sql: "SELECT * FROM draft" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({ error: "Resource not found" });
  });
});

describe("resource_write", () => {
  let adapter: ResourceStorageAdapter;

  beforeEach(() => {
    adapter = makeAdapter({
      mutate: vi.fn<ResourceStorageAdapter["mutate"]>().mockResolvedValue({ applied: true }),
    });
  });

  it("forwards document resource mutations to adapter.mutate()", async () => {
    const tools = createResourceChatTools(adapter, makeMetadata([DOCUMENT_ENTRY]), "ws-1");
    const result = await getTool(tools, "resource_write").execute(
      { slug: "food-log", sql: "SELECT json_set(data, '$.name', ?)", params: ["toast"] },
      TOOL_CALL_OPTS,
    );

    expect(adapter.mutate).toHaveBeenCalledWith(
      "ws-1",
      "food-log",
      "SELECT json_set(data, '$.name', ?)",
      ["toast"],
    );
    expect(result).toEqual({ applied: true });
  });

  it("returns guidance error for external_ref resources", async () => {
    const tools = createResourceChatTools(adapter, makeMetadata([EXTERNAL_ENTRY]), "ws-1");
    const result = await getTool(tools, "resource_write").execute(
      { slug: "notion-meals", sql: "SELECT '{}'" },
      TOOL_CALL_OPTS,
    );

    expect(adapter.mutate).not.toHaveBeenCalled();
    expect(result).toEqual({
      error:
        '"notion-meals" is an external resource (Notion). Use delegate or an agent_<id> tool to interact with it.',
      hint: "Example: delegate({ goal: '...' })",
    });
  });

  it("returns guidance error for artifact_ref resources", async () => {
    const tools = createResourceChatTools(adapter, makeMetadata([ARTIFACT_ENTRY]), "ws-1");
    const result = await getTool(tools, "resource_write").execute(
      { slug: "sales-data", sql: "SELECT '{}'" },
      TOOL_CALL_OPTS,
    );

    expect(adapter.mutate).not.toHaveBeenCalled();
    expect(result).toEqual({
      error:
        '"sales-data" is a read-only file. Use artifacts_get to access it, or agent_data-analyst for queries.',
    });
  });

  it("forwards unknown slugs to Ledger", async () => {
    const tools = createResourceChatTools(adapter, makeMetadata([]), "ws-1");
    await getTool(tools, "resource_write").execute(
      { slug: "new-resource", sql: "SELECT '{}'" },
      TOOL_CALL_OPTS,
    );

    expect(adapter.mutate).toHaveBeenCalledWith("ws-1", "new-resource", "SELECT '{}'", undefined);
  });

  it("surfaces Ledger errors as { error } instead of throwing", async () => {
    adapter = makeAdapter({
      mutate: vi.fn<ResourceStorageAdapter["mutate"]>().mockRejectedValue(new Error("Invalid SQL")),
    });
    const tools = createResourceChatTools(adapter, makeMetadata([DOCUMENT_ENTRY]), "ws-1");
    const result = await getTool(tools, "resource_write").execute(
      { slug: "food-log", sql: "bad sql" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({ error: "Invalid SQL" });
  });
});
