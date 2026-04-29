import type { ValidatedJSONSchema } from "@atlas/schemas/json-schema";
import type { ResourceDeclaration } from "@atlas/schemas/workspace";
import { describe, expect, it } from "vitest";
import { buildDeclarationGuidance, buildResourceGuidance } from "./guidance.ts";
import type { ResourceEntry } from "./types.ts";

describe("buildResourceGuidance", () => {
  it("returns empty string for empty input", () => {
    expect(buildResourceGuidance([])).toBe("");
  });

  it("renders document resources with slug and description", () => {
    const resources: ResourceEntry[] = [
      {
        type: "document",
        slug: "contacts",
        name: "Contacts",
        description: "Customer contact list with enrichment fields",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = buildResourceGuidance(resources);

    expect(result).toContain("## Workspace Resources");
    expect(result).toContain(
      "Documents (use resource_read for queries, resource_write for mutations):",
    );
    expect(result).toContain("- contacts: Customer contact list with enrichment fields");
  });

  it("renders artifact-ref database resources as Datasets", () => {
    const resources: ResourceEntry[] = [
      {
        type: "artifact_ref",
        slug: "sales_data",
        name: "Sales Data",
        description: "Daily sales CSV upload",
        artifactId: "abc-123-uuid",
        artifactType: "file",
        mimeType: "application/x-sqlite3",
        rowCount: 1800000,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = buildResourceGuidance(resources);

    expect(result).toContain("Datasets (read-only, query via data-analyst / DuckDB):");
    expect(result).toContain(
      "- sales_data (artifact abc-123-uuid, 1.8M rows): Daily sales CSV upload",
    );
  });

  it("renders artifact-ref non-database resources as Files", () => {
    const resources: ResourceEntry[] = [
      {
        type: "artifact_ref",
        slug: "product_spec",
        name: "Product Spec",
        description: "Product specification PDF",
        artifactId: "def-456-uuid",
        artifactType: "file",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = buildResourceGuidance(resources);

    expect(result).toContain("Files (read-only, access via artifacts_get):");
    expect(result).toContain("- product_spec (artifact def-456-uuid): Product specification PDF");
  });

  it("renders external-ref resources", () => {
    const resources: ResourceEntry[] = [
      {
        type: "external_ref",
        slug: "analytics_sheet",
        name: "Analytics Sheet",
        description: "Campaign tracking",
        provider: "google-sheets",
        ref: "1abc123",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = buildResourceGuidance(resources);

    expect(result).toContain("External Resources:");
    expect(result).toContain("- analytics_sheet (google-sheets, ref: 1abc123): Campaign tracking");
  });

  it("renders external-ref without ref as unregistered", () => {
    const resources: ResourceEntry[] = [
      {
        type: "external_ref",
        slug: "my_sheet",
        name: "My Sheet",
        description: "Some sheet",
        provider: "google-sheets",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = buildResourceGuidance(resources);

    expect(result).toContain("- my_sheet (google-sheets, unregistered): Some sheet");
    expect(result).toContain(
      "→ Create this resource using google-sheets MCP tools, then call resource_link_ref",
    );
  });

  it("replaces resource_link_ref instruction with delegate when tool is unavailable", () => {
    const resources: ResourceEntry[] = [
      {
        type: "external_ref",
        slug: "my_sheet",
        name: "My Sheet",
        description: "Some sheet",
        provider: "google-sheets",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = buildResourceGuidance(resources, {
      availableTools: ["resource_read", "resource_write"],
    });

    expect(result).toContain("- my_sheet (google-sheets, unregistered): Some sheet");
    expect(result).toContain("→ Use delegate to create and register this resource.");
    expect(result).not.toContain("resource_link_ref");
  });

  it("preserves resource_link_ref instruction when tool is in availableTools", () => {
    const resources: ResourceEntry[] = [
      {
        type: "external_ref",
        slug: "my_sheet",
        name: "My Sheet",
        description: "Some sheet",
        provider: "google-sheets",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = buildResourceGuidance(resources, {
      availableTools: ["resource_read", "resource_write", "resource_link_ref"],
    });

    expect(result).toContain(
      "→ Create this resource using google-sheets MCP tools, then call resource_link_ref",
    );
    expect(result).not.toContain("delegate");
  });

  it("preserves default behavior when options is omitted", () => {
    const resources: ResourceEntry[] = [
      {
        type: "external_ref",
        slug: "my_sheet",
        name: "My Sheet",
        description: "Some sheet",
        provider: "google-sheets",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const withoutOptions = buildResourceGuidance(resources);
    const withUndefined = buildResourceGuidance(resources, undefined);

    expect(withoutOptions).toBe(withUndefined);
    expect(withoutOptions).toContain("resource_link_ref");
    expect(withoutOptions).not.toContain("delegate");
  });

  it("omits artifact-ref entries with artifactType unavailable", () => {
    const resources: ResourceEntry[] = [
      {
        type: "artifact_ref",
        slug: "broken_ref",
        name: "Broken",
        description: "Should not appear",
        artifactId: "gone-uuid",
        artifactType: "unavailable",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = buildResourceGuidance(resources);

    expect(result).toBe("");
  });

  it("renders all categories together in correct order", () => {
    const resources: ResourceEntry[] = [
      {
        type: "document",
        slug: "contacts",
        name: "Contacts",
        description: "Customer contacts",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        type: "artifact_ref",
        slug: "sales_data",
        name: "Sales Data",
        description: "Sales CSV",
        artifactId: "abc-123",
        artifactType: "file",
        mimeType: "application/x-sqlite3",
        rowCount: 50000,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        type: "artifact_ref",
        slug: "product_spec",
        name: "Product Spec",
        description: "Spec PDF",
        artifactId: "def-456",
        artifactType: "file",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        type: "external_ref",
        slug: "analytics_sheet",
        name: "Analytics",
        description: "Campaign tracking",
        provider: "google-sheets",
        ref: "1abc123",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        type: "artifact_ref",
        slug: "broken",
        name: "Broken",
        description: "Should be omitted",
        artifactId: "gone",
        artifactType: "unavailable",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = buildResourceGuidance(resources);

    expect(result).toContain("## Workspace Resources");
    expect(result).toContain("Documents");
    expect(result).toContain("Datasets");
    expect(result).toContain("Files");
    expect(result).toContain("External");
    expect(result).not.toContain("broken");

    // Verify section ordering
    const documentsIdx = result.indexOf("Documents");
    const datasetsIdx = result.indexOf("Datasets");
    const filesIdx = result.indexOf("Files");
    const externalIdx = result.indexOf("External");
    expect(documentsIdx).toBeLessThan(datasetsIdx);
    expect(datasetsIdx).toBeLessThan(filesIdx);
    expect(filesIdx).toBeLessThan(externalIdx);
  });

  it("formats row count with compact notation", () => {
    const resources: ResourceEntry[] = [
      {
        type: "artifact_ref",
        slug: "big_data",
        name: "Big Data",
        description: "Lots of rows",
        artifactId: "big-uuid",
        artifactType: "file",
        mimeType: "application/x-sqlite3",
        rowCount: 2500000,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = buildResourceGuidance(resources);

    expect(result).toContain("2.5M rows");
  });

  it("formats row count in thousands as compact K notation", () => {
    const resources: ResourceEntry[] = [
      {
        type: "artifact_ref",
        slug: "mid_data",
        name: "Mid Data",
        description: "Medium dataset",
        artifactId: "mid-uuid",
        artifactType: "file",
        mimeType: "application/x-sqlite3",
        rowCount: 50000,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = buildResourceGuidance(resources);

    expect(result).toContain("50K rows");
  });

  it("formats 1.5M row count with one decimal place", () => {
    const resources: ResourceEntry[] = [
      {
        type: "artifact_ref",
        slug: "big_data",
        name: "Big Data",
        description: "Large dataset",
        artifactId: "big-uuid",
        artifactType: "file",
        mimeType: "application/x-sqlite3",
        rowCount: 1500000,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = buildResourceGuidance(resources);

    expect(result).toContain("1.5M rows");
  });

  it("formats row count under 1000 as plain number", () => {
    const resources: ResourceEntry[] = [
      {
        type: "artifact_ref",
        slug: "small_data",
        name: "Small Data",
        description: "Few rows",
        artifactId: "small-uuid",
        artifactType: "file",
        mimeType: "application/x-sqlite3",
        rowCount: 42,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = buildResourceGuidance(resources);

    expect(result).toContain("42 rows");
  });

  it("omits row count for datasets when not provided", () => {
    const resources: ResourceEntry[] = [
      {
        type: "artifact_ref",
        slug: "no_count",
        name: "No Count",
        description: "No row count",
        artifactId: "nc-uuid",
        artifactType: "file",
        mimeType: "application/x-sqlite3",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = buildResourceGuidance(resources);

    expect(result).toContain("- no_count (artifact nc-uuid): No row count");
    expect(result).not.toContain("rows");
  });
});

describe("buildDeclarationGuidance", () => {
  it("returns empty string for empty input", () => {
    expect(buildDeclarationGuidance([])).toBe("");
  });

  it("renders document declarations", () => {
    const resources: ResourceDeclaration[] = [
      {
        type: "document",
        slug: "contacts",
        name: "Contacts",
        description: "Customer contact list",
        schema: { type: "object", properties: { name: { type: "string" } } } as ValidatedJSONSchema,
      },
    ];

    const result = buildDeclarationGuidance(resources);

    expect(result).toContain("## Workspace Resources");
    expect(result).toContain(
      "Documents (use resource_read for queries, resource_write for mutations):",
    );
    expect(result).toContain("- contacts: Customer contact list");
  });

  it("renders prose declarations", () => {
    const resources: ResourceDeclaration[] = [
      {
        type: "prose",
        slug: "meeting_notes",
        name: "Meeting Notes",
        description: "Running meeting notes",
      },
    ];

    const result = buildDeclarationGuidance(resources);

    expect(result).toContain("## Workspace Resources");
    expect(result).toContain(
      "Prose Documents (use resource_read / resource_write for full content):",
    );
    expect(result).toContain("- meeting_notes: Running meeting notes");
  });

  it("renders artifact ref declarations", () => {
    const resources: ResourceDeclaration[] = [
      {
        type: "artifact_ref",
        slug: "sales_data",
        name: "Sales Data",
        description: "Uploaded CSV for analysis",
        artifactId: "abc-123-uuid",
      },
    ];

    const result = buildDeclarationGuidance(resources);

    expect(result).toContain("## Workspace Resources");
    expect(result).toContain("Datasets (read-only, query via data-analyst / DuckDB):");
    expect(result).toContain("- sales_data (artifact abc-123-uuid): Uploaded CSV for analysis");
  });

  it("renders external-ref declarations", () => {
    const resources: ResourceDeclaration[] = [
      {
        type: "external_ref",
        slug: "analytics_sheet",
        name: "Analytics Sheet",
        description: "Campaign tracking",
        provider: "google-sheets",
        ref: "1abc123",
      },
    ];

    const result = buildDeclarationGuidance(resources);

    expect(result).toContain("External Resources:");
    expect(result).toContain("- analytics_sheet (google-sheets, ref: 1abc123): Campaign tracking");
  });

  it("renders external-ref without ref as unregistered", () => {
    const resources: ResourceDeclaration[] = [
      {
        type: "external_ref",
        slug: "my_sheet",
        name: "My Sheet",
        description: "Some sheet",
        provider: "notion",
      },
    ];

    const result = buildDeclarationGuidance(resources);

    expect(result).toContain("- my_sheet (notion, unregistered): Some sheet");
    expect(result).toContain(
      "→ Create this resource using notion MCP tools, then call resource_link_ref",
    );
  });

  it("renders documents and external refs together in correct order", () => {
    const resources: ResourceDeclaration[] = [
      {
        type: "document",
        slug: "contacts",
        name: "Contacts",
        description: "Customer contacts",
        schema: { type: "object", properties: { name: { type: "string" } } } as ValidatedJSONSchema,
      },
      {
        type: "external_ref",
        slug: "analytics_sheet",
        name: "Analytics Sheet",
        description: "Campaign tracking",
        provider: "google-sheets",
        ref: "1abc123",
      },
    ];

    const result = buildDeclarationGuidance(resources);

    expect(result).toContain("Documents");
    expect(result).toContain("External");

    const documentsIdx = result.indexOf("Documents");
    const externalIdx = result.indexOf("External");
    expect(documentsIdx).toBeLessThan(externalIdx);
  });
});
