import { type Artifact, ArtifactSchema, type ArtifactStorageAdapter } from "@atlas/core/artifacts";
import type { ResourceStorageAdapter } from "@atlas/ledger";
import { describe, expect, it, vi } from "vitest";
import { enrichCatalogEntries, toCatalogEntries } from "./enrich.ts";
import type { ResourceCatalogEntry } from "./types.ts";

/** Minimal artifact factory for tests */
function makeArtifact(
  overrides: Partial<Artifact> & { id: string; type: Artifact["type"] },
): Artifact {
  return ArtifactSchema.parse({
    revision: 1,
    title: "Test",
    summary: "test artifact",
    createdAt: "2026-01-01T00:00:00Z",
    data: { type: "file", version: 1, data: { path: "/tmp/test.txt", mimeType: "text/plain" } },
    ...overrides,
  });
}

function makeDatabaseArtifact(id: string, rowCount: number): Artifact {
  return makeArtifact({
    id,
    type: "database",
    data: {
      type: "database",
      version: 1,
      data: {
        path: `/tmp/${id}.db`,
        sourceFileName: "data.csv",
        schema: { tableName: "data", rowCount, columns: [{ name: "id", type: "INTEGER" }] },
      },
    },
  });
}

/** Stub adapter that returns provided artifacts from getManyLatest */
function makeStubStorage(artifacts: Artifact[]): ArtifactStorageAdapter {
  const notImpl = () => Promise.resolve({ ok: false as const, error: "not implemented" });
  return {
    create: vi.fn().mockImplementation(notImpl),
    update: vi.fn().mockImplementation(notImpl),
    get: vi.fn().mockImplementation(notImpl),
    deleteArtifact: vi.fn().mockImplementation(notImpl),
    getManyLatest: vi
      .fn<ArtifactStorageAdapter["getManyLatest"]>()
      .mockResolvedValue({ ok: true, data: artifacts }),
    listAll: vi.fn().mockImplementation(notImpl),
    listByWorkspace: vi.fn().mockImplementation(notImpl),
    listByChat: vi.fn().mockImplementation(notImpl),
    readFileContents: vi.fn().mockImplementation(notImpl),
    readBinaryContents: vi.fn().mockImplementation(notImpl),
    readDatabasePreview: vi.fn().mockImplementation(notImpl),
    downloadDatabaseFile: vi.fn().mockImplementation(notImpl),
  };
}

// ---------------------------------------------------------------------------
// toCatalogEntries
// ---------------------------------------------------------------------------

/** Stub adapter that returns a given version data for getResource calls. */
function makeResourceAdapter(resources: Record<string, { data: unknown }>): ResourceStorageAdapter {
  return {
    init: vi.fn(),
    destroy: vi.fn(),
    provision: vi.fn(),
    query: vi.fn(),
    mutate: vi.fn(),
    publish: vi.fn(),
    replaceVersion: vi.fn(),
    listResources: vi.fn(),
    getResource: vi.fn<ResourceStorageAdapter["getResource"]>((_ws, slug) => {
      const r = resources[slug];
      if (!r) return Promise.resolve(null);
      return Promise.resolve({
        metadata: {
          id: `res-${slug}`,
          userId: "u1",
          workspaceId: _ws,
          slug,
          name: slug,
          description: "",
          type: "artifact_ref" as const,
          currentVersion: 1,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        version: {
          id: `ver-${slug}`,
          resourceId: `res-${slug}`,
          userId: "u1",
          version: 1,
          schema: {},
          data: r.data,
          dirty: false,
          draftVersion: 0,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      });
    }),
    deleteResource: vi.fn(),
    linkRef: vi.fn(),
    resetDraft: vi.fn(),
    publishAllDirty: vi.fn<ResourceStorageAdapter["publishAllDirty"]>().mockResolvedValue([]),
    getSkill: vi.fn<ResourceStorageAdapter["getSkill"]>().mockResolvedValue(""),
  };
}

describe("toCatalogEntries", () => {
  const now = "2026-01-15T00:00:00Z";

  it("maps document metadata without calling adapter.getResource", async () => {
    const adapter = makeResourceAdapter({});

    const result = await toCatalogEntries(
      [
        {
          id: "r1",
          userId: "u1",
          workspaceId: "ws1",
          slug: "notes",
          name: "Notes",
          description: "Meeting notes",
          type: "document",
          currentVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      adapter,
      "ws1",
    );

    expect(adapter.getResource).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "document",
      slug: "notes",
      name: "Notes",
      description: "Meeting notes",
      createdAt: now,
      updatedAt: now,
    });
  });

  it("maps artifact_ref metadata with artifactId from resource data (camelCase)", async () => {
    const adapter = makeResourceAdapter({ "my-file": { data: { artifactId: "art-abc" } } });

    const result = await toCatalogEntries(
      [
        {
          id: "r2",
          userId: "u1",
          workspaceId: "ws1",
          slug: "my-file",
          name: "My File",
          description: "Uploaded file",
          type: "artifact_ref",
          currentVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      adapter,
      "ws1",
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "artifact_ref",
      slug: "my-file",
      name: "My File",
      description: "Uploaded file",
      artifactId: "art-abc",
      createdAt: now,
      updatedAt: now,
    });
  });

  it("falls back to empty artifactId when data has no artifactId field", async () => {
    const adapter = makeResourceAdapter({ "bad-ref": { data: { unrelated: "value" } } });

    const result = await toCatalogEntries(
      [
        {
          id: "r3",
          userId: "u1",
          workspaceId: "ws1",
          slug: "bad-ref",
          name: "Bad Ref",
          description: "Missing artifactId",
          type: "artifact_ref",
          currentVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      adapter,
      "ws1",
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "artifact_ref", artifactId: "" });
  });

  it("maps external_ref metadata with provider, ref, and metadata from resource data", async () => {
    const adapter = makeResourceAdapter({
      "github-repo": { data: { provider: "github", ref: "org/repo", metadata: { stars: 42 } } },
    });

    const result = await toCatalogEntries(
      [
        {
          id: "r4",
          userId: "u1",
          workspaceId: "ws1",
          slug: "github-repo",
          name: "GitHub Repo",
          description: "Main repo",
          type: "external_ref",
          currentVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      adapter,
      "ws1",
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "external_ref",
      slug: "github-repo",
      name: "GitHub Repo",
      description: "Main repo",
      provider: "github",
      ref: "org/repo",
      metadata: { stars: 42 },
      createdAt: now,
      updatedAt: now,
    });
  });

  it("handles mixed resource types in a single call", async () => {
    const adapter = makeResourceAdapter({
      "my-file": { data: { artifactId: "art-1" } },
      "ext-link": { data: { provider: "slack", ref: "#general" } },
    });

    const result = await toCatalogEntries(
      [
        {
          id: "r1",
          userId: "u1",
          workspaceId: "ws1",
          slug: "doc",
          name: "Doc",
          description: "A document",
          type: "document",
          currentVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "r2",
          userId: "u1",
          workspaceId: "ws1",
          slug: "my-file",
          name: "File",
          description: "A file",
          type: "artifact_ref",
          currentVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "r3",
          userId: "u1",
          workspaceId: "ws1",
          slug: "ext-link",
          name: "External",
          description: "External link",
          type: "external_ref",
          currentVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      adapter,
      "ws1",
    );

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ type: "document", slug: "doc" });
    expect(result[1]).toMatchObject({ type: "artifact_ref", slug: "my-file", artifactId: "art-1" });
    expect(result[2]).toMatchObject({ type: "external_ref", slug: "ext-link", provider: "slack" });
  });

  it("skips non-document resources when getResource returns null", async () => {
    const adapter = makeResourceAdapter({});

    const result = await toCatalogEntries(
      [
        {
          id: "r1",
          userId: "u1",
          workspaceId: "ws1",
          slug: "missing",
          name: "Missing",
          description: "Deleted",
          type: "artifact_ref",
          currentVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      adapter,
      "ws1",
    );

    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// enrichCatalogEntries
// ---------------------------------------------------------------------------

describe("enrichCatalogEntries", () => {
  const now = "2026-01-15T00:00:00Z";

  it("passes document entries through unchanged", async () => {
    const entries: ResourceCatalogEntry[] = [
      {
        type: "document",
        slug: "users",
        name: "Users",
        description: "User records",
        createdAt: now,
        updatedAt: now,
      },
    ];

    const result = await enrichCatalogEntries(entries, makeStubStorage([]));

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(entries[0]);
  });

  it("passes external_ref entries through unchanged", async () => {
    const entries: ResourceCatalogEntry[] = [
      {
        type: "external_ref",
        slug: "github-repo",
        name: "GitHub Repo",
        description: "Main repo",
        provider: "github",
        ref: "org/repo",
        createdAt: now,
        updatedAt: now,
      },
    ];

    const result = await enrichCatalogEntries(entries, makeStubStorage([]));

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(entries[0]);
  });

  it("enriches artifact-ref entries with artifactType from resolved artifact", async () => {
    const artifact = makeArtifact({ id: "art-1", type: "file" });
    const entries: ResourceCatalogEntry[] = [
      {
        type: "artifact_ref",
        slug: "my-file",
        name: "My File",
        description: "A file resource",
        artifactId: "art-1",
        createdAt: now,
        updatedAt: now,
      },
    ];

    const result = await enrichCatalogEntries(entries, makeStubStorage([artifact]));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "artifact_ref",
      slug: "my-file",
      artifactId: "art-1",
      artifactType: "file",
    });
    expect(result[0]).not.toHaveProperty("rowCount");
  });

  it("enriches database artifact-ref entries with rowCount", async () => {
    const artifact = makeDatabaseArtifact("art-db", 150);
    const entries: ResourceCatalogEntry[] = [
      {
        type: "artifact_ref",
        slug: "my-db",
        name: "My Database",
        description: "A database resource",
        artifactId: "art-db",
        createdAt: now,
        updatedAt: now,
      },
    ];

    const result = await enrichCatalogEntries(entries, makeStubStorage([artifact]));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "artifact_ref",
      artifactType: "database",
      rowCount: 150,
    });
  });

  it("produces artifactType 'unavailable' for missing artifacts", async () => {
    const entries: ResourceCatalogEntry[] = [
      {
        type: "artifact_ref",
        slug: "deleted-thing",
        name: "Deleted",
        description: "Was deleted",
        artifactId: "art-gone",
        createdAt: now,
        updatedAt: now,
      },
    ];

    const result = await enrichCatalogEntries(entries, makeStubStorage([]));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "artifact_ref",
      artifactId: "art-gone",
      artifactType: "unavailable",
    });
    expect(result[0]).not.toHaveProperty("rowCount");
  });

  it("makes a single batch getManyLatest call for all artifact-ref entries", async () => {
    const storage = makeStubStorage([]);

    const entries: ResourceCatalogEntry[] = [
      {
        type: "artifact_ref",
        slug: "a",
        name: "A",
        description: "",
        artifactId: "art-1",
        createdAt: now,
        updatedAt: now,
      },
      { type: "document", slug: "b", name: "B", description: "", createdAt: now, updatedAt: now },
      {
        type: "artifact_ref",
        slug: "c",
        name: "C",
        description: "",
        artifactId: "art-2",
        createdAt: now,
        updatedAt: now,
      },
    ];

    await enrichCatalogEntries(entries, storage);

    expect(storage.getManyLatest).toHaveBeenCalledTimes(1);
    expect(storage.getManyLatest).toHaveBeenCalledWith({ ids: ["art-1", "art-2"] });
  });

  it("handles mixed entry types in a single call", async () => {
    const fileArtifact = makeArtifact({ id: "art-file", type: "file" });
    const dbArtifact = makeDatabaseArtifact("art-db", 99);

    const entries: ResourceCatalogEntry[] = [
      {
        type: "document",
        slug: "d1",
        name: "Document",
        description: "",
        createdAt: now,
        updatedAt: now,
      },
      {
        type: "artifact_ref",
        slug: "f1",
        name: "File",
        description: "",
        artifactId: "art-file",
        createdAt: now,
        updatedAt: now,
      },
      {
        type: "external_ref",
        slug: "e1",
        name: "External",
        description: "",
        provider: "slack",
        createdAt: now,
        updatedAt: now,
      },
      {
        type: "artifact_ref",
        slug: "db1",
        name: "DB",
        description: "",
        artifactId: "art-db",
        createdAt: now,
        updatedAt: now,
      },
      {
        type: "artifact_ref",
        slug: "m1",
        name: "Missing",
        description: "",
        artifactId: "art-missing",
        createdAt: now,
        updatedAt: now,
      },
    ];

    const result = await enrichCatalogEntries(entries, makeStubStorage([fileArtifact, dbArtifact]));

    expect(result).toHaveLength(5);
    expect(result[0]).toMatchObject({ type: "document", slug: "d1" });
    expect(result[1]).toMatchObject({ type: "artifact_ref", slug: "f1", artifactType: "file" });
    expect(result[2]).toMatchObject({ type: "external_ref", slug: "e1" });
    expect(result[3]).toMatchObject({
      type: "artifact_ref",
      slug: "db1",
      artifactType: "database",
      rowCount: 99,
    });
    expect(result[4]).toMatchObject({
      type: "artifact_ref",
      slug: "m1",
      artifactType: "unavailable",
    });
    expect(result[1]).not.toHaveProperty("rowCount");
    expect(result[4]).not.toHaveProperty("rowCount");
  });

  it("returns empty array for empty input", async () => {
    const result = await enrichCatalogEntries([], makeStubStorage([]));
    expect(result).toEqual([]);
  });

  it("skips getManyLatest when no artifact-ref entries exist", async () => {
    const storage = makeStubStorage([]);

    const entries: ResourceCatalogEntry[] = [
      { type: "document", slug: "d", name: "D", description: "", createdAt: now, updatedAt: now },
    ];

    await enrichCatalogEntries(entries, storage);
    expect(storage.getManyLatest).not.toHaveBeenCalled();
  });
});
