import type { ResourceStorageAdapter } from "@atlas/ledger";
import type { ResourceDeclaration } from "@atlas/schemas/workspace";
import { describe, expect, test, vi } from "vitest";
import { provisionResources } from "./provision-resources.ts";

function mockAdapter(overrides: Partial<ResourceStorageAdapter> = {}): ResourceStorageAdapter {
  return {
    init: vi.fn<ResourceStorageAdapter["init"]>().mockResolvedValue(undefined),
    destroy: vi.fn<ResourceStorageAdapter["destroy"]>().mockResolvedValue(undefined),
    provision: vi
      .fn<ResourceStorageAdapter["provision"]>()
      .mockResolvedValue({
        id: "res-1",
        userId: "user-1",
        workspaceId: "ws-001",
        slug: "test",
        name: "Test",
        description: "Test resource",
        type: "document",
        currentVersion: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    query: vi.fn<ResourceStorageAdapter["query"]>().mockResolvedValue({ rows: [], rowCount: 0 }),
    mutate: vi.fn<ResourceStorageAdapter["mutate"]>().mockResolvedValue({ applied: false }),
    publish: vi.fn<ResourceStorageAdapter["publish"]>().mockResolvedValue({ version: null }),
    replaceVersion: vi
      .fn<ResourceStorageAdapter["replaceVersion"]>()
      .mockResolvedValue({
        id: "v-1",
        resourceId: "res-1",
        userId: "user-1",
        version: 1,
        schema: {},
        data: {},
        dirty: false,
        draftVersion: 0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    listResources: vi.fn<ResourceStorageAdapter["listResources"]>().mockResolvedValue([]),
    getResource: vi.fn<ResourceStorageAdapter["getResource"]>().mockResolvedValue(null),
    deleteResource: vi.fn<ResourceStorageAdapter["deleteResource"]>().mockResolvedValue(undefined),
    linkRef: vi
      .fn<ResourceStorageAdapter["linkRef"]>()
      .mockResolvedValue({
        id: "v-1",
        resourceId: "res-1",
        userId: "user-1",
        version: 1,
        schema: {},
        data: {},
        dirty: false,
        draftVersion: 0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    resetDraft: vi.fn<ResourceStorageAdapter["resetDraft"]>().mockResolvedValue(undefined),
    publishAllDirty: vi.fn<ResourceStorageAdapter["publishAllDirty"]>().mockResolvedValue([]),
    getSkill: vi.fn<ResourceStorageAdapter["getSkill"]>().mockResolvedValue(""),
    ...overrides,
  };
}

const DOCUMENT_RESOURCE: ResourceDeclaration = {
  type: "document",
  slug: "leads",
  name: "Leads",
  description: "Sales leads tracking table",
  schema: {
    type: "object",
    properties: {
      company: { type: "string" },
      status: { type: "string", enum: ["new", "contacted", "qualified"] },
    },
    required: ["company"],
  },
};

const PROSE_RESOURCE: ResourceDeclaration = {
  type: "prose",
  slug: "meeting_notes",
  name: "Meeting Notes",
  description: "Running meeting notes in markdown",
};

const DOCUMENT_WITH_NESTED_SCHEMA: ResourceDeclaration = {
  type: "document",
  slug: "org_chart",
  name: "Org Chart",
  description: "Organizational structure",
  schema: {
    type: "object",
    properties: { name: { type: "string" }, reports: { type: "array", items: { type: "object" } } },
    required: ["name"],
  },
};

const ARTIFACT_REF: ResourceDeclaration = {
  type: "artifact_ref",
  slug: "sales_data",
  name: "Sales Data",
  description: "Uploaded CSV for analysis",
  artifactId: "artifact-123",
};

const EXTERNAL_REF: ResourceDeclaration = {
  type: "external_ref",
  slug: "crm_sheet",
  name: "CRM Sheet",
  description: "Google Sheet tracking CRM data",
  provider: "google-sheets",
  ref: "https://docs.google.com/spreadsheets/d/abc123",
  metadata: { sheetName: "Pipeline" },
};

const EXTERNAL_REF_NO_REF: ResourceDeclaration = {
  type: "external_ref",
  slug: "tracker",
  name: "Tracker",
  description: "Notion tracker to be created by agent",
  provider: "notion",
};

describe("provisionResources", () => {
  const workspaceId = "ws-001";
  const userId = "user-1";

  test("provisions document resource with schema and empty array data", async () => {
    const adapter = mockAdapter();

    const result = await provisionResources(adapter, workspaceId, userId, [DOCUMENT_RESOURCE]);

    expect(result.ok).toBe(true);
    expect(adapter.provision).toHaveBeenCalledWith(
      workspaceId,
      {
        userId,
        slug: "leads",
        name: "Leads",
        description: "Sales leads tracking table",
        type: "document",
        schema: DOCUMENT_RESOURCE.schema,
      },
      [],
    );
  });

  test("provisions prose resource as document type with markdown schema", async () => {
    const adapter = mockAdapter();

    const result = await provisionResources(adapter, workspaceId, userId, [PROSE_RESOURCE]);

    expect(result.ok).toBe(true);
    expect(adapter.provision).toHaveBeenCalledWith(
      workspaceId,
      {
        userId,
        slug: "meeting_notes",
        name: "Meeting Notes",
        description: "Running meeting notes in markdown",
        type: "document",
        schema: { type: "string", format: "markdown" },
      },
      "",
    );
  });

  test("provisions document resource with nested schema properties", async () => {
    const adapter = mockAdapter();

    const result = await provisionResources(adapter, workspaceId, userId, [
      DOCUMENT_WITH_NESTED_SCHEMA,
    ]);

    expect(result.ok).toBe(true);
    expect(adapter.provision).toHaveBeenCalledWith(
      workspaceId,
      {
        userId,
        slug: "org_chart",
        name: "Org Chart",
        description: "Organizational structure",
        type: "document",
        schema: DOCUMENT_WITH_NESTED_SCHEMA.schema,
      },
      [],
    );
  });

  test("provisions artifact_ref with artifact ID in initial data", async () => {
    const adapter = mockAdapter();

    const result = await provisionResources(adapter, workspaceId, userId, [ARTIFACT_REF]);

    expect(result.ok).toBe(true);
    expect(adapter.provision).toHaveBeenCalledWith(
      workspaceId,
      {
        userId,
        slug: "sales_data",
        name: "Sales Data",
        description: "Uploaded CSV for analysis",
        type: "artifact_ref",
        schema: {},
      },
      { artifact_id: "artifact-123" },
    );
  });

  test("provisions external_ref with provider and ref in initial data", async () => {
    const adapter = mockAdapter();

    const result = await provisionResources(adapter, workspaceId, userId, [EXTERNAL_REF]);

    expect(result.ok).toBe(true);
    expect(adapter.provision).toHaveBeenCalledWith(
      workspaceId,
      {
        userId,
        slug: "crm_sheet",
        name: "CRM Sheet",
        description: "Google Sheet tracking CRM data",
        type: "external_ref",
        schema: {},
      },
      {
        provider: "google-sheets",
        ref: "https://docs.google.com/spreadsheets/d/abc123",
        metadata: { sheetName: "Pipeline" },
      },
    );
  });

  test("provisions external_ref without ref field", async () => {
    const adapter = mockAdapter();

    const result = await provisionResources(adapter, workspaceId, userId, [EXTERNAL_REF_NO_REF]);

    expect(result.ok).toBe(true);
    expect(adapter.provision).toHaveBeenCalledWith(
      workspaceId,
      {
        userId,
        slug: "tracker",
        name: "Tracker",
        description: "Notion tracker to be created by agent",
        type: "external_ref",
        schema: {},
      },
      { provider: "notion" },
    );
  });

  test("handles mixed resource types", async () => {
    const adapter = mockAdapter();

    const result = await provisionResources(adapter, workspaceId, userId, [
      DOCUMENT_RESOURCE,
      EXTERNAL_REF,
    ]);

    expect(result.ok).toBe(true);
    expect(adapter.provision).toHaveBeenCalledTimes(2);
  });

  test("returns error when provision fails with resource context", async () => {
    const adapter = mockAdapter({
      provision: vi
        .fn<ResourceStorageAdapter["provision"]>()
        .mockRejectedValue(new Error("Ledger provision failed (500): duplicate slug")),
    });

    const result = await provisionResources(adapter, workspaceId, userId, [DOCUMENT_RESOURCE]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("leads");
      expect(result.error).toContain("duplicate slug");
    }
  });

  test("succeeds with empty resources array", async () => {
    const adapter = mockAdapter();

    const result = await provisionResources(adapter, workspaceId, userId, []);

    expect(result.ok).toBe(true);
    expect(adapter.provision).not.toHaveBeenCalled();
  });

  test("stops on first failure", async () => {
    const adapter = mockAdapter({
      provision: vi
        .fn<ResourceStorageAdapter["provision"]>()
        .mockResolvedValueOnce({
          id: "res-1",
          userId: "user-1",
          workspaceId: "ws-001",
          slug: "leads",
          name: "Leads",
          description: "Test",
          type: "document",
          currentVersion: 1,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        })
        .mockRejectedValueOnce(new Error("boom")),
    });

    const result = await provisionResources(adapter, workspaceId, userId, [
      DOCUMENT_RESOURCE,
      EXTERNAL_REF,
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("crm_sheet");
    }
    expect(adapter.provision).toHaveBeenCalledTimes(2);
  });
});
