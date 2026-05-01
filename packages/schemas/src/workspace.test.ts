import { describe, expect, it } from "vitest";
import {
  ArtifactRefDeclarationSchema,
  ClassifiedDAGStepSchema,
  DocumentResourceDeclarationSchema,
  ExternalRefDeclarationSchema,
  ProseResourceDeclarationSchema,
  ResourceDeclarationSchema,
  WorkspaceBlueprintSchema,
} from "./workspace.ts";

// ---------------------------------------------------------------------------
// DocumentResourceDeclarationSchema
// ---------------------------------------------------------------------------

describe("DocumentResourceDeclarationSchema", () => {
  const valid = {
    type: "document" as const,
    slug: "user_notes",
    name: "User Notes",
    description: "Notes created by the user",
    schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  };

  it("accepts a valid document resource declaration", () => {
    expect(DocumentResourceDeclarationSchema.parse(valid)).toEqual(valid);
  });

  it("rejects slugs with hyphens", () => {
    expect(() =>
      DocumentResourceDeclarationSchema.parse({ ...valid, slug: "user-notes" }),
    ).toThrow();
  });

  it("rejects slugs starting with a number", () => {
    expect(() => DocumentResourceDeclarationSchema.parse({ ...valid, slug: "1notes" })).toThrow();
  });

  it("rejects slugs with uppercase letters", () => {
    expect(() =>
      DocumentResourceDeclarationSchema.parse({ ...valid, slug: "UserNotes" }),
    ).toThrow();
  });

  it("accepts single-word slugs", () => {
    expect(DocumentResourceDeclarationSchema.parse({ ...valid, slug: "notes" }).slug).toBe("notes");
  });
});

// ---------------------------------------------------------------------------
// ProseResourceDeclarationSchema
// ---------------------------------------------------------------------------

describe("ProseResourceDeclarationSchema", () => {
  const valid = {
    type: "prose" as const,
    slug: "meeting_notes",
    name: "Meeting Notes",
    description: "Running meeting notes in markdown",
  };

  it("accepts a valid prose resource declaration", () => {
    expect(ProseResourceDeclarationSchema.parse(valid)).toEqual(valid);
  });

  it("rejects extra properties (no schema field)", () => {
    expect(() =>
      ProseResourceDeclarationSchema.parse({ ...valid, schema: { type: "string" } }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ArtifactRefDeclarationSchema
// ---------------------------------------------------------------------------

describe("ArtifactRefDeclarationSchema", () => {
  const valid = {
    type: "artifact_ref" as const,
    slug: "sales_data",
    name: "Sales Data",
    description: "Uploaded CSV for analysis",
    artifactId: "abc-123-uuid",
  };

  it("accepts a valid artifact ref declaration", () => {
    expect(ArtifactRefDeclarationSchema.parse(valid)).toEqual(valid);
  });

  it("requires artifactId", () => {
    const { artifactId: _, ...withoutArtifact } = valid;
    expect(() => ArtifactRefDeclarationSchema.parse(withoutArtifact)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ExternalRefDeclarationSchema
// ---------------------------------------------------------------------------

describe("ExternalRefDeclarationSchema", () => {
  const valid = {
    type: "external_ref" as const,
    slug: "project_tracker",
    name: "Project Tracker",
    description: "Airtable project tracking sheet",
    provider: "airtable",
  };

  it("accepts a valid external ref declaration", () => {
    expect(ExternalRefDeclarationSchema.parse(valid)).toEqual(valid);
  });

  it("accepts all provider values", () => {
    for (const provider of ["google-sheets", "notion", "airtable", "github", "url"]) {
      expect(ExternalRefDeclarationSchema.parse({ ...valid, provider }).provider).toBe(provider);
    }
  });

  it("accepts optional ref and metadata", () => {
    const full = { ...valid, ref: "https://example.com/sheet", metadata: { sheetId: "abc" } };
    expect(ExternalRefDeclarationSchema.parse(full)).toEqual(full);
  });

  it("rejects unknown provider", () => {
    expect(() => ExternalRefDeclarationSchema.parse({ ...valid, provider: "dropbox" })).toThrow();
  });

  it("rejects slugs with hyphens", () => {
    expect(() =>
      ExternalRefDeclarationSchema.parse({ ...valid, slug: "project-tracker" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ResourceDeclarationSchema — union on `type`
// ---------------------------------------------------------------------------

describe("ResourceDeclarationSchema", () => {
  it("parses a document resource", () => {
    const doc = {
      type: "document" as const,
      slug: "tasks",
      name: "Tasks",
      description: "Task list",
      schema: { type: "object", properties: { title: { type: "string" } } },
    };
    expect(ResourceDeclarationSchema.parse(doc)).toEqual(doc);
  });

  it("parses a prose resource", () => {
    const prose = {
      type: "prose" as const,
      slug: "notes",
      name: "Notes",
      description: "Markdown notes",
    };
    expect(ResourceDeclarationSchema.parse(prose)).toEqual(prose);
  });

  it("parses a document with nested schema properties", () => {
    const doc = {
      type: "document" as const,
      slug: "briefs",
      name: "Briefs",
      description: "Research briefs with hierarchical structure",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          topics: {
            type: "array",
            items: { type: "object", properties: { name: { type: "string" } } },
          },
        },
      },
    };
    expect(ResourceDeclarationSchema.parse(doc)).toEqual(doc);
  });

  it("parses an artifact ref", () => {
    const ref = {
      type: "artifact_ref" as const,
      slug: "data",
      name: "Data",
      description: "Uploaded data",
      artifactId: "abc-123",
    };
    expect(ResourceDeclarationSchema.parse(ref)).toEqual(ref);
  });

  it("parses an external ref", () => {
    const ref = {
      type: "external_ref" as const,
      slug: "sheet",
      name: "Sheet",
      description: "Google sheet",
      provider: "google-sheets",
    };
    expect(ResourceDeclarationSchema.parse(ref)).toEqual(ref);
  });
});

// ---------------------------------------------------------------------------
// WorkspaceBlueprintSchema — resources field
// ---------------------------------------------------------------------------

describe("WorkspaceBlueprintSchema resources field", () => {
  const minimalBlueprint = {
    workspace: { name: "Test", purpose: "Testing" },
    signals: [],
    agents: [],
    jobs: [],
  };

  it("accepts a blueprint without resources (backwards compatible)", () => {
    const result = WorkspaceBlueprintSchema.safeParse(minimalBlueprint);
    expect(result.success).toBe(true);
  });

  it("accepts a blueprint with an empty resources array", () => {
    const result = WorkspaceBlueprintSchema.safeParse({ ...minimalBlueprint, resources: [] });
    expect(result.success).toBe(true);
  });

  it("accepts a blueprint with mixed resource declarations", () => {
    const resources = [
      {
        type: "document" as const,
        slug: "notes",
        name: "Notes",
        description: "User notes",
        schema: { type: "object", properties: { text: { type: "string" } } },
      },
      { type: "prose" as const, slug: "report", name: "Report", description: "Weekly report" },
      {
        type: "external_ref" as const,
        slug: "tracker",
        name: "Tracker",
        description: "Project tracker",
        provider: "notion",
      },
    ];
    const result = WorkspaceBlueprintSchema.safeParse({ ...minimalBlueprint, resources });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ClassifiedDAGStepSchema — v2 migration backfill
// ---------------------------------------------------------------------------

describe("ClassifiedDAGStepSchema", () => {
  it("backfills executionRef from agentId when missing (v2 migration)", () => {
    const result = ClassifiedDAGStepSchema.parse({
      id: "step-1",
      agentId: "email",
      description: "Send an email",
      depends_on: [],
      executionType: "bundled" as const,
      tools: ["send-email"],
    });

    expect(result.executionRef).toBe("email");
    expect(result.agentId).toBe("email");
  });
});
