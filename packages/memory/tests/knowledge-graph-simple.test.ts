import { expect } from "@std/expect";
import { KnowledgeEntityType, KnowledgeRelationType } from "../src/knowledge-graph.ts";

// Set testing environment to prevent logger file operations
Deno.env.set("DENO_TESTING", "true");

Deno.test("KnowledgeEntityType - enum values are correct", () => {
  expect(KnowledgeEntityType.PERSON).toBe("person");
  expect(KnowledgeEntityType.PROJECT).toBe("project");
  expect(KnowledgeEntityType.SERVICE).toBe("service");
  expect(KnowledgeEntityType.CONCEPT).toBe("concept");
  expect(KnowledgeEntityType.PREFERENCE).toBe("preference");
  expect(KnowledgeEntityType.IDENTIFIER).toBe("identifier");
  expect(KnowledgeEntityType.TEAM).toBe("team");
  expect(KnowledgeEntityType.TECHNOLOGY).toBe("technology");
  expect(KnowledgeEntityType.LOCATION).toBe("location");
  expect(KnowledgeEntityType.FACT).toBe("fact");
});

Deno.test("KnowledgeRelationType - enum values are correct", () => {
  expect(KnowledgeRelationType.IS_A).toBe("is_a");
  expect(KnowledgeRelationType.PART_OF).toBe("part_of");
  expect(KnowledgeRelationType.WORKS_ON).toBe("works_on");
  expect(KnowledgeRelationType.USES).toBe("uses");
  expect(KnowledgeRelationType.PREFERS).toBe("prefers");
  expect(KnowledgeRelationType.OWNS).toBe("owns");
  expect(KnowledgeRelationType.MEMBER_OF).toBe("member_of");
  expect(KnowledgeRelationType.LOCATED_AT).toBe("located_at");
  expect(KnowledgeRelationType.RELATED_TO).toBe("related_to");
  expect(KnowledgeRelationType.HAS_ATTRIBUTE).toBe("has_attribute");
  expect(KnowledgeRelationType.KNOWS).toBe("knows");
});

Deno.test("KnowledgeEntity - interface structure", () => {
  const mockEntity = {
    id: "entity-123",
    type: KnowledgeEntityType.PERSON,
    name: "Alice Johnson",
    attributes: {
      role: "Software Engineer",
      team: "Platform Team",
      skills: ["TypeScript", "React", "Node.js"],
      location: "San Francisco",
    },
    confidence: 0.95,
    source: "team-directory",
    timestamp: new Date("2024-01-01T00:00:00Z"),
    workspaceId: "workspace-456",
  };

  expect(mockEntity.id).toBe("entity-123");
  expect(mockEntity.type).toBe(KnowledgeEntityType.PERSON);
  expect(mockEntity.name).toBe("Alice Johnson");
  expect(mockEntity.attributes.role).toBe("Software Engineer");
  expect(mockEntity.attributes.skills).toContain("TypeScript");
  expect(mockEntity.confidence).toBe(0.95);
  expect(mockEntity.source).toBe("team-directory");
  expect(mockEntity.workspaceId).toBe("workspace-456");
});

Deno.test("KnowledgeRelationship - interface structure", () => {
  const mockRelationship = {
    id: "relationship-789",
    type: KnowledgeRelationType.WORKS_ON,
    sourceEntityId: "person-123",
    targetEntityId: "project-456",
    attributes: {
      role: "Lead Developer",
      startDate: "2024-01-01",
      commitment: "Full-time",
    },
    confidence: 0.9,
    source: "project-assignment",
    timestamp: new Date("2024-01-01T00:00:00Z"),
    workspaceId: "workspace-456",
  };

  expect(mockRelationship.id).toBe("relationship-789");
  expect(mockRelationship.type).toBe(KnowledgeRelationType.WORKS_ON);
  expect(mockRelationship.sourceEntityId).toBe("person-123");
  expect(mockRelationship.targetEntityId).toBe("project-456");
  expect(mockRelationship.attributes.role).toBe("Lead Developer");
  expect(mockRelationship.confidence).toBe(0.9);
  expect(mockRelationship.source).toBe("project-assignment");
  expect(mockRelationship.workspaceId).toBe("workspace-456");
});

Deno.test("KnowledgeFact - interface structure", () => {
  const mockFact = {
    id: "fact-999",
    statement: "Alice Johnson is the lead developer on the Atlas project",
    entities: [
      {
        id: "person-123",
        type: KnowledgeEntityType.PERSON,
        name: "Alice Johnson",
        attributes: { role: "Lead Developer" },
        confidence: 0.95,
        source: "team-directory",
        timestamp: new Date(),
        workspaceId: "workspace-456",
      },
      {
        id: "project-456",
        type: KnowledgeEntityType.PROJECT,
        name: "Atlas",
        attributes: { status: "active" },
        confidence: 1.0,
        source: "project-registry",
        timestamp: new Date(),
        workspaceId: "workspace-456",
      },
    ],
    relationships: [
      {
        id: "relationship-789",
        type: KnowledgeRelationType.WORKS_ON,
        sourceEntityId: "person-123",
        targetEntityId: "project-456",
        attributes: { role: "Lead Developer" },
        confidence: 0.9,
        source: "project-assignment",
        timestamp: new Date(),
        workspaceId: "workspace-456",
      },
    ],
    confidence: 0.92,
    source: "team-meeting-notes",
    timestamp: new Date("2024-01-01T00:00:00Z"),
    workspaceId: "workspace-456",
    tags: ["personnel", "project-assignment", "leadership"],
    validated: true,
  };

  expect(mockFact.id).toBe("fact-999");
  expect(mockFact.statement).toContain("Alice Johnson");
  expect(mockFact.statement).toContain("Atlas project");
  expect(mockFact.entities).toHaveLength(2);
  expect(mockFact.relationships).toHaveLength(1);
  expect(mockFact.entities[0].type).toBe(KnowledgeEntityType.PERSON);
  expect(mockFact.entities[1].type).toBe(KnowledgeEntityType.PROJECT);
  expect(mockFact.relationships[0].type).toBe(KnowledgeRelationType.WORKS_ON);
  expect(mockFact.confidence).toBe(0.92);
  expect(mockFact.tags).toContain("personnel");
  expect(mockFact.validated).toBe(true);
});

Deno.test("KnowledgeGraphManager - can be imported", async () => {
  const { KnowledgeGraphManager } = await import("../src/knowledge-graph.ts");
  expect(KnowledgeGraphManager).toBeDefined();
  expect(typeof KnowledgeGraphManager).toBe("function");
});

Deno.test("KnowledgeGraphManager - exports from mod.ts", async () => {
  const { KnowledgeGraphManager } = await import("../mod.ts");
  expect(KnowledgeGraphManager).toBeDefined();
  expect(typeof KnowledgeGraphManager).toBe("function");
});

Deno.test("Entity type validation", () => {
  const entityTypes = Object.values(KnowledgeEntityType);

  expect(entityTypes).toContain("person");
  expect(entityTypes).toContain("project");
  expect(entityTypes).toContain("service");
  expect(entityTypes).toContain("concept");
  expect(entityTypes).toContain("preference");
  expect(entityTypes).toContain("identifier");
  expect(entityTypes).toContain("team");
  expect(entityTypes).toContain("technology");
  expect(entityTypes).toContain("location");
  expect(entityTypes).toContain("fact");

  expect(entityTypes).toHaveLength(10);
});

Deno.test("Relationship type validation", () => {
  const relationshipTypes = Object.values(KnowledgeRelationType);

  expect(relationshipTypes).toContain("is_a");
  expect(relationshipTypes).toContain("part_of");
  expect(relationshipTypes).toContain("works_on");
  expect(relationshipTypes).toContain("uses");
  expect(relationshipTypes).toContain("prefers");
  expect(relationshipTypes).toContain("owns");
  expect(relationshipTypes).toContain("member_of");
  expect(relationshipTypes).toContain("located_at");
  expect(relationshipTypes).toContain("related_to");
  expect(relationshipTypes).toContain("has_attribute");
  expect(relationshipTypes).toContain("knows");

  expect(relationshipTypes).toHaveLength(11);
});

Deno.test("Knowledge graph query structure", () => {
  const mockQuery = {
    workspaceId: "workspace-123",
    entityTypes: [KnowledgeEntityType.PERSON, KnowledgeEntityType.PROJECT],
    relationshipTypes: [KnowledgeRelationType.WORKS_ON, KnowledgeRelationType.MEMBER_OF],
    entityNames: ["Alice", "Bob"],
    minConfidence: 0.8,
    search: "Atlas project",
    limit: 50,
  };

  expect(mockQuery.workspaceId).toBe("workspace-123");
  expect(mockQuery.entityTypes).toContain(KnowledgeEntityType.PERSON);
  expect(mockQuery.entityTypes).toContain(KnowledgeEntityType.PROJECT);
  expect(mockQuery.relationshipTypes).toContain(KnowledgeRelationType.WORKS_ON);
  expect(mockQuery.relationshipTypes).toContain(KnowledgeRelationType.MEMBER_OF);
  expect(mockQuery.entityNames).toContain("Alice");
  expect(mockQuery.entityNames).toContain("Bob");
  expect(mockQuery.minConfidence).toBe(0.8);
  expect(mockQuery.search).toBe("Atlas project");
  expect(mockQuery.limit).toBe(50);
});

Deno.test("Extracted fact structure", () => {
  const mockExtractedFact = {
    type: "person_info" as const,
    statement: "John Smith prefers to work with React and TypeScript",
    entities: [
      {
        type: KnowledgeEntityType.PERSON,
        name: "John Smith",
        attributes: { role: "developer" },
      },
      {
        type: KnowledgeEntityType.TECHNOLOGY,
        name: "React",
        attributes: { category: "framework" },
      },
      {
        type: KnowledgeEntityType.TECHNOLOGY,
        name: "TypeScript",
        attributes: { category: "language" },
      },
    ],
    relationships: [
      {
        type: KnowledgeRelationType.PREFERS,
        source: "John Smith",
        target: "React",
        attributes: { strength: "high" },
      },
      {
        type: KnowledgeRelationType.PREFERS,
        source: "John Smith",
        target: "TypeScript",
        attributes: { strength: "high" },
      },
    ],
    confidence: 0.85,
    context: "team preference survey",
  };

  expect(mockExtractedFact.type).toBe("person_info");
  expect(mockExtractedFact.statement).toContain("John Smith");
  expect(mockExtractedFact.entities).toHaveLength(3);
  expect(mockExtractedFact.relationships).toHaveLength(2);
  expect(mockExtractedFact.entities[0].type).toBe(KnowledgeEntityType.PERSON);
  expect(mockExtractedFact.entities[1].type).toBe(KnowledgeEntityType.TECHNOLOGY);
  expect(mockExtractedFact.relationships[0].type).toBe(KnowledgeRelationType.PREFERS);
  expect(mockExtractedFact.confidence).toBe(0.85);
  expect(mockExtractedFact.context).toBe("team preference survey");
});
