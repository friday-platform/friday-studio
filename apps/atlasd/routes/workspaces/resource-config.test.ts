import type { ResourceMetadata, ResourceVersion } from "@atlas/ledger";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { provisionConfigResources, toConfigResourceDeclaration } from "./index.ts";

// Mock external deps that index.ts imports at module level
vi.mock("@atlas/storage", () => ({
  storeWorkspaceHistory: vi.fn(),
  FilesystemWorkspaceCreationAdapter: vi.fn(),
}));
vi.mock("../me/adapter.ts", () => ({ getCurrentUser: vi.fn() }));

const mockProvision = vi.hoisted(() => vi.fn<() => Promise<ResourceMetadata>>());
vi.mock("@atlas/resources", () => ({ createLedgerClient: () => ({ provision: mockProvision }) }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetadata(overrides: Partial<ResourceMetadata> = {}): ResourceMetadata {
  return {
    id: "res-1",
    userId: "user-1",
    workspaceId: "ws-1",
    slug: "test-resource",
    name: "Test Resource",
    description: "A test resource",
    type: "document",
    currentVersion: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeVersion(overrides: Partial<ResourceVersion> = {}): ResourceVersion {
  return {
    id: "ver-1",
    resourceId: "res-1",
    userId: "user-1",
    version: 1,
    schema: {},
    data: [],
    dirty: false,
    draftVersion: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// toConfigResourceDeclaration
// ---------------------------------------------------------------------------

describe("toConfigResourceDeclaration", () => {
  test("document with tabular schema", () => {
    const schema = { type: "array", items: { type: "object" } };
    const result = toConfigResourceDeclaration(
      makeMetadata({ type: "document" }),
      makeVersion({ schema }),
    );

    expect(result).toEqual({
      type: "document",
      slug: "test-resource",
      name: "Test Resource",
      description: "A test resource",
      schema,
    });
  });

  test("document with markdown schema → prose", () => {
    const result = toConfigResourceDeclaration(
      makeMetadata({ type: "document" }),
      makeVersion({ schema: { type: "string", format: "markdown" } }),
    );

    expect(result).toEqual({
      type: "prose",
      slug: "test-resource",
      name: "Test Resource",
      description: "A test resource",
    });
  });

  test("document with null schema falls back to empty object", () => {
    const result = toConfigResourceDeclaration(
      makeMetadata({ type: "document" }),
      makeVersion({ schema: null }),
    );

    expect(result).toEqual({
      type: "document",
      slug: "test-resource",
      name: "Test Resource",
      description: "A test resource",
      schema: {},
    });
  });

  test("artifact_ref extracts artifact_id from data", () => {
    const result = toConfigResourceDeclaration(
      makeMetadata({ type: "artifact_ref" }),
      makeVersion({ data: { artifact_id: "art-abc" } }),
    );

    expect(result).toEqual({
      type: "artifact_ref",
      slug: "test-resource",
      name: "Test Resource",
      description: "A test resource",
      artifactId: "art-abc",
    });
  });

  test("artifact_ref with malformed data falls back to empty artifactId", () => {
    const result = toConfigResourceDeclaration(
      makeMetadata({ type: "artifact_ref" }),
      makeVersion({ data: { wrong_field: 42 } }),
    );

    expect(result.type).toBe("artifact_ref");
    expect(result).toHaveProperty("artifactId", "");
  });

  test("external_ref with all fields", () => {
    const result = toConfigResourceDeclaration(
      makeMetadata({ type: "external_ref" }),
      makeVersion({
        data: { provider: "google_sheets", ref: "sheet-id-123", metadata: { tab: "Sheet1" } },
      }),
    );

    expect(result).toEqual({
      type: "external_ref",
      slug: "test-resource",
      name: "Test Resource",
      description: "A test resource",
      provider: "google_sheets",
      ref: "sheet-id-123",
      metadata: { tab: "Sheet1" },
    });
  });

  test("external_ref with only provider (ref and metadata omitted)", () => {
    const result = toConfigResourceDeclaration(
      makeMetadata({ type: "external_ref" }),
      makeVersion({ data: { provider: "notion" } }),
    );

    expect(result).toEqual({
      type: "external_ref",
      slug: "test-resource",
      name: "Test Resource",
      description: "A test resource",
      provider: "notion",
    });
  });

  test("external_ref with malformed data falls back to empty provider", () => {
    const result = toConfigResourceDeclaration(
      makeMetadata({ type: "external_ref" }),
      makeVersion({ data: "not-an-object" }),
    );

    expect(result.type).toBe("external_ref");
    expect(result).toHaveProperty("provider", "");
  });
});

// ---------------------------------------------------------------------------
// provisionConfigResources
// ---------------------------------------------------------------------------

describe("provisionConfigResources", () => {
  const stubLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

  beforeEach(() => {
    mockProvision.mockReset();
    stubLogger.warn.mockClear();
  });

  test("provisions all resource types successfully", async () => {
    mockProvision.mockResolvedValue(makeMetadata());

    const resources = [
      {
        type: "document" as const,
        slug: "doc",
        name: "Doc",
        description: "d",
        schema: { type: "array" },
      },
      { type: "prose" as const, slug: "prose", name: "Prose", description: "p" },
      {
        type: "artifact_ref" as const,
        slug: "art",
        name: "Art",
        description: "a",
        artifactId: "art-1",
      },
      {
        type: "external_ref" as const,
        slug: "ext",
        name: "Ext",
        description: "e",
        provider: "notion",
      },
    ];

    const errors = await provisionConfigResources("ws-1", "user-1", resources, stubLogger as never);

    expect(errors).toEqual([]);
    expect(mockProvision).toHaveBeenCalledTimes(4);

    // Verify prose is mapped to document type with markdown schema
    expect(mockProvision).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({
        slug: "prose",
        type: "document",
        schema: { type: "string", format: "markdown" },
      }),
      "",
    );
  });

  test("collects per-resource errors without aborting", async () => {
    mockProvision
      .mockResolvedValueOnce(makeMetadata())
      .mockRejectedValueOnce(new Error("Ledger unavailable"))
      .mockResolvedValueOnce(makeMetadata());

    const resources = [
      { type: "prose" as const, slug: "ok-1", name: "OK", description: "d" },
      { type: "prose" as const, slug: "fail", name: "Fail", description: "d" },
      { type: "prose" as const, slug: "ok-2", name: "OK2", description: "d" },
    ];

    const errors = await provisionConfigResources("ws-1", "user-1", resources, stubLogger as never);

    expect(errors).toEqual(["fail: Ledger unavailable"]);
    expect(mockProvision).toHaveBeenCalledTimes(3);
    expect(stubLogger.warn).toHaveBeenCalledOnce();
  });
});
