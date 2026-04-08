/**
 * Tests for resource endpoints:
 * - GET /:workspaceId/resources (list)
 * - GET /:workspaceId/resources/:slug (detail)
 * - GET /:workspaceId/resources/:slug/export (CSV export)
 * - POST /:workspaceId/resources/upload (upload)
 * - PUT /:workspaceId/resources/:slug (replace)
 * - DELETE /:workspaceId/resources/:slug (delete)
 */

import {
  type ResourceMetadata,
  ResourceMetadataSchema,
  type ResourceStorageAdapter,
  type ResourceWithData,
  ResourceWithDataSchema,
} from "@atlas/ledger";
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { AppContext, AppVariables } from "../../src/factory.ts";
import { workspacesRoutes } from "./index.ts";

// ---------------------------------------------------------------------------
// Response schemas — typed boundaries for every endpoint shape
// ---------------------------------------------------------------------------

const ListResponseSchema = z.object({
  resources: z.array(
    z.object({ type: z.string(), slug: z.string(), name: z.string() }).passthrough(),
  ),
});

const TabularDetailSchema = z.object({
  format: z.literal("tabular"),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number(),
  totalRows: z.number(),
  truncated: z.boolean(),
  readonly: z.boolean(),
});

const ProseDetailSchema = z.object({
  format: z.literal("prose"),
  content: z.string(),
  readonly: z.boolean(),
});

const ErrorResponseSchema = z.object({ error: z.string() });
const SuccessResponseSchema = z.object({ success: z.literal(true) });
const ResourceResponseSchema = z.object({ resource: ResourceMetadataSchema });

/** Parse response JSON through a Zod schema — replaces all `as JsonBody` casts. */
async function parseJson<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await res.json());
}

// ---------------------------------------------------------------------------
// Module mocks — external dependencies the route handlers import
// ---------------------------------------------------------------------------

vi.mock("@atlas/analytics", () => ({
  createAnalyticsClient: () => ({ emit: vi.fn() }),
  EventNames: { WORKSPACE_CREATED: "workspace.created" },
}));
vi.mock("../me/adapter.ts", () => ({ getCurrentUser: vi.fn().mockResolvedValue({ ok: false }) }));

const mockDeleteArtifact = vi.hoisted(() => vi.fn());
const mockArtifactCreate = vi.hoisted(() => vi.fn());
vi.mock("@atlas/core/artifacts/server", () => ({
  ArtifactStorage: {
    getManyLatest: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    deleteArtifact: mockDeleteArtifact,
    downloadDatabaseFile: vi.fn(),
    create: mockArtifactCreate,
  },
}));

const mockReplaceArtifactFromFile = vi.hoisted(() => vi.fn());
const mockStreamToFile = vi.hoisted(() => vi.fn());
vi.mock("../artifacts.ts", () => ({
  replaceArtifactFromFile: mockReplaceArtifactFromFile,
  streamToFile: mockStreamToFile,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, copyFile: vi.fn().mockResolvedValue(undefined) };
});

// ---------------------------------------------------------------------------
// Fixture helpers — validated through Zod schemas so drift is caught early
// ---------------------------------------------------------------------------

/** Build a ResourceMetadata fixture, validated against the production schema. */
function meta(overrides: Partial<ResourceMetadata> & { slug: string }): ResourceMetadata {
  return ResourceMetadataSchema.parse({
    id: `res-${overrides.slug}`,
    userId: "local",
    workspaceId: "ws-1",
    name: overrides.slug,
    description: "",
    type: "document",
    currentVersion: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

/** Build a ResourceWithData fixture, validated against the production schema. */
function withData(metadata: ResourceMetadata, data: unknown, schema?: unknown): ResourceWithData {
  return ResourceWithDataSchema.parse({
    metadata,
    version: {
      id: `ver-${metadata.slug}`,
      resourceId: metadata.id,
      userId: metadata.userId,
      version: metadata.currentVersion,
      schema: schema ?? null,
      data,
      dirty: false,
      draftVersion: 0,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
    },
  });
}

// ---------------------------------------------------------------------------
// Test app factory — mock Ledger adapter injected into Hono context
// ---------------------------------------------------------------------------

function createMockLedgerAdapter(
  overrides: Partial<ResourceStorageAdapter> = {},
): ResourceStorageAdapter {
  return {
    init: vi.fn<() => Promise<void>>(),
    destroy: vi.fn<() => Promise<void>>(),
    provision: vi.fn().mockResolvedValue(meta({ slug: "test" })),
    query: vi.fn(),
    mutate: vi.fn(),
    publish: vi.fn(),
    replaceVersion: vi.fn(),
    listResources: vi.fn().mockResolvedValue([]),
    getResource: vi.fn().mockResolvedValue(null),
    deleteResource: vi.fn<() => Promise<void>>(),
    linkRef: vi.fn(),
    resetDraft: vi.fn<() => Promise<void>>(),
    publishAllDirty: vi.fn<ResourceStorageAdapter["publishAllDirty"]>().mockResolvedValue([]),
    getSkill: vi.fn<() => Promise<string>>().mockResolvedValue(""),
    ...overrides,
  };
}

function createTestApp(overrides: Partial<ResourceStorageAdapter> = {}) {
  const ledger = createMockLedgerAdapter(overrides);

  const mockContext: AppContext = {
    runtimes: new Map(),
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: vi
      .fn()
      .mockReturnValue({
        find: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue([]),
        getWorkspaceConfig: vi.fn().mockResolvedValue(null),
        registerWorkspace: vi.fn(),
        deleteWorkspace: vi.fn(),
      }),
    getOrCreateWorkspaceRuntime: vi.fn(),
    resetIdleTimeout: vi.fn(),
    getWorkspaceRuntime: vi.fn(),
    destroyWorkspaceRuntime: vi.fn(),
    getLibraryStorage: vi.fn(),
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    evictChatSdkInstance: vi.fn(),
    getLedgerAdapter: () => ledger,
    getActivityAdapter: vi.fn(),
    daemon: {} as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
    sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
  };

  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    await next();
  });
  app.route("/", workspacesRoutes);

  return { app, ledger };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /:workspaceId/resources", () => {
  test("returns enriched resource list from Ledger", async () => {
    const usersMeta = meta({ slug: "users", name: "Users", description: "User data" });
    const { app } = createTestApp({ listResources: vi.fn().mockResolvedValue([usersMeta]) });

    const res = await app.request("/ws-1/resources");

    expect(res.status).toBe(200);
    const body = await parseJson(res, ListResponseSchema);
    expect(body.resources).toHaveLength(1);
    expect(body.resources[0]).toMatchObject({ slug: "users", name: "Users" });
  });

  test("returns 500 when Ledger throws", async () => {
    const { app } = createTestApp({
      listResources: vi.fn().mockRejectedValue(new Error("db gone")),
    });

    const res = await app.request("/ws-1/resources");

    expect(res.status).toBe(500);
    const body = await parseJson(res, ErrorResponseSchema);
    expect(body.error).toContain("db gone");
  });
});

describe("GET /:workspaceId/resources/:slug", () => {
  test("returns columns and rows for tabular document resources", async () => {
    const usersMeta = meta({ slug: "users", name: "Users", description: "User data" });
    const rows = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ];
    const schema = {
      type: "object",
      properties: { id: { type: "number" }, name: { type: "string" } },
    };
    const { app } = createTestApp({
      getResource: vi.fn().mockResolvedValue(withData(usersMeta, rows, schema)),
    });

    const res = await app.request("/ws-1/resources/users");

    expect(res.status).toBe(200);
    const body = await parseJson(res, TabularDetailSchema);
    expect(body.format).toBe("tabular");
    expect(body.columns).toEqual(["id", "name"]);
    expect(body.rows).toHaveLength(2);
    expect(body.rowCount).toBe(2);
    expect(body.totalRows).toBe(2);
    expect(body.truncated).toBe(false);
    expect(body.readonly).toBe(false);
  });

  test("returns markdown content for prose document resources", async () => {
    const notesMeta = meta({ slug: "meeting-notes", name: "Meeting Notes" });
    const proseSchema = { type: "string", format: "markdown" };
    const content = "# Sprint Planning\n\n- Item 1\n- Item 2";
    const { app } = createTestApp({
      getResource: vi.fn().mockResolvedValue(withData(notesMeta, content, proseSchema)),
    });

    const res = await app.request("/ws-1/resources/meeting-notes");

    expect(res.status).toBe(200);
    const body = await parseJson(res, ProseDetailSchema);
    expect(body.format).toBe("prose");
    expect(body.content).toBe("# Sprint Planning\n\n- Item 1\n- Item 2");
    expect(body.readonly).toBe(false);
  });

  test("returns 404 for non-existent slug", async () => {
    const { app } = createTestApp();
    const res = await app.request("/ws-1/resources/nope");
    expect(res.status).toBe(404);
  });

  test("returns 404 for non-document resource types", async () => {
    const refMeta = meta({ slug: "github-repo", type: "external_ref" });
    const { app } = createTestApp({
      getResource: vi.fn().mockResolvedValue(withData(refMeta, { ref: "abc" })),
    });

    const res = await app.request("/ws-1/resources/github-repo");

    expect(res.status).toBe(404);
    const body = await parseJson(res, ErrorResponseSchema);
    expect(body.error).toContain("document");
  });
});

describe("GET /:workspaceId/resources/:slug/export", () => {
  test("streams CSV with correct headers for document resources", async () => {
    const contactsMeta = meta({ slug: "contacts", name: "Contacts" });
    const rows = [
      { id: 1, name: "Alice", email: "alice@example.com" },
      { id: 2, name: "Bob", email: "bob@example.com" },
    ];
    const { app } = createTestApp({
      getResource: vi.fn().mockResolvedValue(withData(contactsMeta, rows)),
    });

    const res = await app.request("/ws-1/resources/contacts/export");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="contacts.csv"');

    const csv = await res.text();
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe("id,name,email");
    expect(lines).toHaveLength(3); // header + 2 rows
  });

  test("escapes CSV values containing commas, quotes, and newlines", async () => {
    const notesMeta = meta({ slug: "notes" });
    const rows = [{ id: 1, text: 'has "quotes" and, commas' }];
    const { app } = createTestApp({
      getResource: vi.fn().mockResolvedValue(withData(notesMeta, rows)),
    });

    const res = await app.request("/ws-1/resources/notes/export");

    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain('"has ""quotes"" and, commas"');
  });

  test("returns 404 for non-document resource types", async () => {
    const refMeta = meta({ slug: "big-file", type: "artifact_ref" });
    const { app } = createTestApp({
      getResource: vi.fn().mockResolvedValue(withData(refMeta, { artifactId: "art-1" })),
    });

    const res = await app.request("/ws-1/resources/big-file/export");
    expect(res.status).toBe(404);
  });

  test("returns 404 for non-existent slug", async () => {
    const { app } = createTestApp();
    const res = await app.request("/ws-1/resources/nope/export");
    expect(res.status).toBe(404);
  });
});

describe("PUT /:workspaceId/resources/:slug", () => {
  beforeEach(() => {
    mockReplaceArtifactFromFile.mockReset();
    mockStreamToFile.mockReset();
    mockStreamToFile.mockResolvedValue(undefined);
  });

  test("replaces document resource with CSV via Ledger replaceVersion", async () => {
    const usersMeta = meta({ slug: "users", name: "Users", description: "User data" });
    const updatedMeta = meta({
      slug: "users",
      name: "Users",
      description: "User data",
      updatedAt: "2026-02-26T00:00:00Z",
    });
    const { app, ledger } = createTestApp({
      getResource: vi
        .fn()
        .mockResolvedValueOnce(withData(usersMeta, []))
        .mockResolvedValueOnce(withData(updatedMeta, [{ id: "1", name: "Alice" }])),
      replaceVersion: vi
        .fn()
        .mockResolvedValue({
          id: "ver-new",
          resourceId: usersMeta.id,
          userId: "local",
          version: 2,
          schema: null,
          data: [{ id: "1", name: "Alice" }],
          dirty: false,
          createdAt: "2026-02-26T00:00:00Z",
        }),
    });

    const formData = new FormData();
    formData.append("file", new File(["id,name\n1,Alice"], "users.csv", { type: "text/csv" }));

    const res = await app.request("/ws-1/resources/users", { method: "PUT", body: formData });

    expect(res.status).toBe(200);
    const body = await parseJson(res, ResourceResponseSchema);
    expect(body.resource).toMatchObject({ slug: "users" });
    expect(ledger.replaceVersion).toHaveBeenCalledWith(
      "ws-1",
      "users",
      expect.arrayContaining([{ id: "1", name: "Alice" }]),
      expect.objectContaining({ type: "object" }),
    );
  });

  test("rejects non-CSV for tabular document resource with 422", async () => {
    const usersMeta = meta({ slug: "users" });
    const { app } = createTestApp({
      getResource: vi.fn().mockResolvedValue(withData(usersMeta, [])),
    });

    const formData = new FormData();
    formData.append("file", new File(["some text"], "data.txt", { type: "text/plain" }));

    const res = await app.request("/ws-1/resources/users", { method: "PUT", body: formData });

    expect(res.status).toBe(422);
    const body = await parseJson(res, ErrorResponseSchema);
    expect(body.error).toContain("Table resources require a CSV file");
  });

  test("replaces prose document resource with markdown file", async () => {
    const proseSchema = { type: "string", format: "markdown" };
    const readmeMeta = meta({ slug: "readme", name: "readme", description: "A readme" });
    const updatedMeta = meta({
      slug: "readme",
      name: "readme",
      description: "A readme",
      updatedAt: "2026-02-26T00:00:00Z",
    });
    const { app, ledger } = createTestApp({
      getResource: vi
        .fn()
        .mockResolvedValueOnce(withData(readmeMeta, "# Old content", proseSchema))
        .mockResolvedValueOnce(withData(updatedMeta, "# Updated content", proseSchema)),
      replaceVersion: vi
        .fn()
        .mockResolvedValue({
          id: "ver-new",
          resourceId: readmeMeta.id,
          userId: "local",
          version: 2,
          schema: null,
          data: "# Updated content",
          dirty: false,
          createdAt: "2026-02-26T00:00:00Z",
        }),
    });

    const formData = new FormData();
    formData.append(
      "file",
      new File(["# Updated content"], "readme.md", { type: "text/markdown" }),
    );

    const res = await app.request("/ws-1/resources/readme", { method: "PUT", body: formData });

    expect(res.status).toBe(200);
    const body = await parseJson(res, ResourceResponseSchema);
    expect(body.resource).toMatchObject({ slug: "readme" });
    expect(ledger.replaceVersion).toHaveBeenCalledWith("ws-1", "readme", "# Updated content");
  });

  test("rejects non-markdown for prose document resource with 422", async () => {
    const proseSchema = { type: "string", format: "markdown" };
    const readmeMeta = meta({ slug: "readme" });
    const { app } = createTestApp({
      getResource: vi.fn().mockResolvedValue(withData(readmeMeta, "# Old content", proseSchema)),
    });

    const formData = new FormData();
    formData.append("file", new File(["id,name\n1,Alice"], "data.csv", { type: "text/csv" }));

    const res = await app.request("/ws-1/resources/readme", { method: "PUT", body: formData });

    expect(res.status).toBe(422);
    const body = await parseJson(res, ErrorResponseSchema);
    expect(body.error).toContain("Prose resources require a markdown file");
  });

  test("replaces artifact-ref resource via artifact replacement", async () => {
    const reportMeta = meta({ slug: "report", type: "artifact_ref" });
    const updatedMeta = meta({
      slug: "report",
      type: "artifact_ref",
      updatedAt: "2026-02-26T00:00:00Z",
    });
    const { app, ledger } = createTestApp({
      getResource: vi
        .fn()
        .mockResolvedValueOnce(withData(reportMeta, { artifactId: "art-2" }))
        .mockResolvedValueOnce(withData(updatedMeta, { artifactId: "art-2" })),
    });

    mockReplaceArtifactFromFile.mockResolvedValue({
      ok: true,
      artifact: {
        id: "art-2",
        data: {
          type: "file",
          version: 1,
          data: { path: "/tmp/report.pdf", originalName: "report.pdf" },
        },
      },
    });

    const formData = new FormData();
    formData.append("file", new File(["pdf content"], "report.pdf"));

    const res = await app.request("/ws-1/resources/report", { method: "PUT", body: formData });

    expect(res.status).toBe(200);
    expect(ledger.replaceVersion).not.toHaveBeenCalled();
    expect(mockReplaceArtifactFromFile).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: "art-2" }),
    );
  });

  test("returns 404 for non-existent slug", async () => {
    const { app } = createTestApp();

    const formData = new FormData();
    formData.append("file", new File(["data"], "data.csv", { type: "text/csv" }));

    const res = await app.request("/ws-1/resources/nope", { method: "PUT", body: formData });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /:workspaceId/resources/:slug", () => {
  beforeEach(() => {
    mockDeleteArtifact.mockReset();
    mockDeleteArtifact.mockResolvedValue({ ok: true, data: undefined });
  });

  test("deletes document resource via Ledger", async () => {
    const usersMeta = meta({ slug: "users" });
    const { app, ledger } = createTestApp({
      getResource: vi.fn().mockResolvedValue(withData(usersMeta, [])),
    });

    const res = await app.request("/ws-1/resources/users", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = await parseJson(res, SuccessResponseSchema);
    expect(body.success).toBe(true);
    expect(ledger.deleteResource).toHaveBeenCalledWith("ws-1", "users");
  });

  test("deletes artifact_ref resource and cleans up backing artifact", async () => {
    const reportMeta = meta({ slug: "report", type: "artifact_ref" });
    const { app, ledger } = createTestApp({
      getResource: vi.fn().mockResolvedValue(withData(reportMeta, { artifactId: "art-2" })),
    });

    const res = await app.request("/ws-1/resources/report", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(ledger.deleteResource).toHaveBeenCalledWith("ws-1", "report");
    expect(mockDeleteArtifact).toHaveBeenCalledWith({ id: "art-2" });
  });

  test("returns 404 for non-existent slug", async () => {
    const { app } = createTestApp();

    const res = await app.request("/ws-1/resources/nope", { method: "DELETE" });

    expect(res.status).toBe(404);
    const body = await parseJson(res, ErrorResponseSchema);
    expect(body.error).toContain("not found");
  });

  test("succeeds even if backing artifact delete fails", async () => {
    const oldMeta = meta({ slug: "old", type: "artifact_ref" });
    const { app } = createTestApp({
      getResource: vi.fn().mockResolvedValue(withData(oldMeta, { artifactId: "art-gone" })),
    });
    mockDeleteArtifact.mockResolvedValue({ ok: false, error: "artifact not found" });

    const res = await app.request("/ws-1/resources/old", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = await parseJson(res, SuccessResponseSchema);
    expect(body.success).toBe(true);
  });
});

describe("POST /:workspaceId/resources/upload", () => {
  beforeEach(() => {
    mockArtifactCreate.mockReset();
    mockStreamToFile.mockReset();
    mockStreamToFile.mockResolvedValue(undefined);
  });

  test("small CSV provisions as document resource with JSONB data", async () => {
    const provisionMeta = meta({
      slug: "contacts",
      name: "contacts",
      description: "Uploaded from contacts.csv",
    });
    const { app, ledger } = createTestApp({
      getResource: vi.fn().mockResolvedValue(null),
      provision: vi.fn().mockResolvedValue(provisionMeta),
    });

    const formData = new FormData();
    formData.append(
      "file",
      new File(["id,name\n1,Alice\n2,Bob\n3,Carol"], "contacts.csv", { type: "text/csv" }),
    );

    const res = await app.request("/ws-1/resources/upload", { method: "POST", body: formData });

    expect(res.status).toBe(201);
    const body = await parseJson(res, ResourceResponseSchema);
    expect(body.resource).toMatchObject({ type: "document", slug: "contacts" });

    expect(ledger.provision).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({
        slug: "contacts",
        name: "contacts",
        type: "document",
        schema: expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({ id: { type: "string" }, name: { type: "string" } }),
        }),
      }),
      expect.arrayContaining([
        { id: "1", name: "Alice" },
        { id: "2", name: "Bob" },
      ]),
    );
  });

  test("small markdown provisions as prose resource", async () => {
    const provisionMeta = meta({
      slug: "readme",
      name: "readme",
      description: "Uploaded from readme.md",
    });
    const { app, ledger } = createTestApp({
      getResource: vi.fn().mockResolvedValue(null),
      provision: vi.fn().mockResolvedValue(provisionMeta),
    });

    const formData = new FormData();
    formData.append(
      "file",
      new File(["# Hello World\n\nSome content."], "readme.md", { type: "text/markdown" }),
    );

    const res = await app.request("/ws-1/resources/upload", { method: "POST", body: formData });

    expect(res.status).toBe(201);
    const body = await parseJson(res, ResourceResponseSchema);
    expect(body.resource).toMatchObject({ slug: "readme" });

    expect(ledger.provision).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({
        slug: "readme",
        type: "document",
        schema: { type: "string", format: "markdown" },
      }),
      "# Hello World\n\nSome content.",
    );
  });

  test("large file provisions as artifact_ref resource", async () => {
    const provisionMeta = meta({
      slug: "big_file",
      name: "big-file",
      description: "Uploaded from big-file.csv",
      type: "artifact_ref",
    });
    mockArtifactCreate.mockResolvedValue({ ok: true, data: { id: "art-big", type: "file" } });
    const { app, ledger } = createTestApp({
      getResource: vi.fn().mockResolvedValue(null),
      provision: vi.fn().mockResolvedValue(provisionMeta),
    });

    const bigContent = "x".repeat(6 * 1024 * 1024);
    const formData = new FormData();
    formData.append("file", new File([bigContent], "big-file.csv", { type: "text/csv" }));

    const res = await app.request("/ws-1/resources/upload", { method: "POST", body: formData });

    expect(res.status).toBe(201);
    const body = await parseJson(res, ResourceResponseSchema);
    expect(body.resource).toMatchObject({ type: "artifact_ref" });

    expect(ledger.provision).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ slug: "big_file", type: "artifact_ref" }),
      expect.objectContaining({ artifactId: "art-big" }),
    );
    expect(mockArtifactCreate).toHaveBeenCalledWith(
      expect.objectContaining({ source: "resource_upload" }),
    );
  });

  test("returns 409 on slug collision", async () => {
    const usersMeta = meta({ slug: "users" });
    const { app } = createTestApp({
      getResource: vi.fn().mockResolvedValue(withData(usersMeta, [])),
    });

    const formData = new FormData();
    formData.append("file", new File(["id,name\n1,A"], "users.csv", { type: "text/csv" }));

    const res = await app.request("/ws-1/resources/upload", { method: "POST", body: formData });

    expect(res.status).toBe(409);
    const body = await parseJson(res, ErrorResponseSchema);
    expect(body.error).toContain("already exists");
  });

  test("derives slug from filename", async () => {
    const provisionMeta = meta({
      slug: "my_great_report",
      name: "My Great Report",
      description: "Uploaded from My Great Report.txt",
      type: "artifact_ref",
    });
    mockArtifactCreate.mockResolvedValue({ ok: true, data: { id: "art-x", type: "file" } });
    const { app, ledger } = createTestApp({
      getResource: vi.fn().mockResolvedValue(null),
      provision: vi.fn().mockResolvedValue(provisionMeta),
    });

    const formData = new FormData();
    formData.append("file", new File(["content"], "My Great Report.txt", { type: "text/plain" }));

    const res = await app.request("/ws-1/resources/upload", { method: "POST", body: formData });

    expect(res.status).toBe(201);
    expect(ledger.provision).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ slug: "my_great_report" }),
      expect.anything(),
    );
  });
});

const LinkResponseSchema = z.object({
  slug: z.string(),
  name: z.string(),
  provider: z.string(),
  ref: z.string(),
});

describe("POST /:workspaceId/resources/link", () => {
  test("creates external_ref resource via Ledger provision", async () => {
    const provisionMeta = meta({ slug: "notion_doc", name: "Notion Doc", type: "external_ref" });
    const { app, ledger } = createTestApp({
      getResource: vi.fn().mockResolvedValue(null),
      provision: vi.fn().mockResolvedValue(provisionMeta),
    });

    const res = await app.request("/ws-1/resources/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://notion.so/doc-123",
        name: "Notion Doc",
        provider: "notion",
      }),
    });

    expect(res.status).toBe(201);
    const body = await parseJson(res, LinkResponseSchema);
    expect(body).toMatchObject({
      slug: "notion_doc",
      name: "Notion Doc",
      provider: "notion",
      ref: "https://notion.so/doc-123",
    });

    expect(ledger.provision).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({
        slug: "notion_doc",
        name: "Notion Doc",
        type: "external_ref",
        schema: {},
      }),
      { provider: "notion", ref: "https://notion.so/doc-123", metadata: {} },
    );
  });

  test("returns 409 on slug collision", async () => {
    const existingMeta = meta({ slug: "notion_doc", type: "external_ref" });
    const { app } = createTestApp({
      getResource: vi.fn().mockResolvedValue(withData(existingMeta, {})),
    });

    const res = await app.request("/ws-1/resources/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://notion.so/doc-456",
        name: "Notion Doc",
        provider: "notion",
      }),
    });

    expect(res.status).toBe(409);
    const body = await parseJson(res, ErrorResponseSchema);
    expect(body.error).toContain("already exists");
  });

  test("returns 400 on invalid body", async () => {
    const { app } = createTestApp();

    const res = await app.request("/ws-1/resources/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });

    expect(res.status).toBe(400);
  });
});
