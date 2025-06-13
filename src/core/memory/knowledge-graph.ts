/**
 * Knowledge Graph Implementation for Semantic Memory
 * Enhances semantic memory to work as a structured knowledge base
 */

import { CoALAMemoryType } from "./coala-memory.ts";

// Knowledge graph entity types
export enum KnowledgeEntityType {
  PERSON = "person",
  PROJECT = "project",
  SERVICE = "service",
  CONCEPT = "concept",
  PREFERENCE = "preference",
  IDENTIFIER = "identifier",
  TEAM = "team",
  TECHNOLOGY = "technology",
  LOCATION = "location",
  FACT = "fact",
}

// Relationship types between entities
export enum KnowledgeRelationType {
  IS_A = "is_a",
  PART_OF = "part_of",
  WORKS_ON = "works_on",
  USES = "uses",
  PREFERS = "prefers",
  OWNS = "owns",
  MEMBER_OF = "member_of",
  LOCATED_AT = "located_at",
  RELATED_TO = "related_to",
  HAS_ATTRIBUTE = "has_attribute",
  KNOWS = "knows",
}

// Knowledge graph entity
export interface KnowledgeEntity {
  id: string;
  type: KnowledgeEntityType;
  name: string;
  attributes: Record<string, any>;
  confidence: number;
  source: string; // Where this entity was extracted from
  timestamp: Date;
  workspaceId: string;
}

// Knowledge graph relationship
export interface KnowledgeRelationship {
  id: string;
  type: KnowledgeRelationType;
  sourceEntityId: string;
  targetEntityId: string;
  attributes: Record<string, any>;
  confidence: number;
  source: string;
  timestamp: Date;
  workspaceId: string;
}

// Knowledge graph fact (combines entity and relationship)
export interface KnowledgeFact {
  id: string;
  statement: string; // Natural language statement
  entities: KnowledgeEntity[];
  relationships: KnowledgeRelationship[];
  confidence: number;
  source: string;
  timestamp: Date;
  workspaceId: string;
  tags: string[];
  validated: boolean;
}

// Extracted fact from signal analysis
export interface ExtractedFact {
  type:
    | "person_info"
    | "preference"
    | "identifier"
    | "service_info"
    | "team_info"
    | "project_info"
    | "general_fact";
  statement: string;
  entities: {
    type: KnowledgeEntityType;
    name: string;
    attributes: Record<string, any>;
  }[];
  relationships: {
    type: KnowledgeRelationType;
    source: string;
    target: string;
    attributes: Record<string, any>;
  }[];
  confidence: number;
  context: string;
}

// Knowledge graph query interface
export interface KnowledgeGraphQuery {
  entityTypes?: KnowledgeEntityType[];
  relationshipTypes?: KnowledgeRelationType[];
  entityNames?: string[];
  search?: string; // Text search across entities and facts
  workspaceId?: string;
  minConfidence?: number;
  limit?: number;
}

// Knowledge graph storage adapter interface
export interface IKnowledgeGraphStorageAdapter {
  // Entity operations
  storeEntity(entity: KnowledgeEntity): Promise<void>;
  getEntity(id: string): Promise<KnowledgeEntity | null>;
  queryEntities(query: KnowledgeGraphQuery): Promise<KnowledgeEntity[]>;
  updateEntity(id: string, updates: Partial<KnowledgeEntity>): Promise<void>;
  deleteEntity(id: string): Promise<void>;

  // Relationship operations
  storeRelationship(relationship: KnowledgeRelationship): Promise<void>;
  getRelationship(id: string): Promise<KnowledgeRelationship | null>;
  queryRelationships(query: KnowledgeGraphQuery): Promise<KnowledgeRelationship[]>;
  getEntityRelationships(entityId: string): Promise<KnowledgeRelationship[]>;
  deleteRelationship(id: string): Promise<void>;

  // Fact operations
  storeFact(fact: KnowledgeFact): Promise<void>;
  getFact(id: string): Promise<KnowledgeFact | null>;
  queryFacts(query: KnowledgeGraphQuery): Promise<KnowledgeFact[]>;
  deleteFact(id: string): Promise<void>;

  // Graph operations
  findPaths(
    sourceEntityId: string,
    targetEntityId: string,
    maxDepth: number,
  ): Promise<KnowledgeRelationship[][]>;
  getNeighbors(entityId: string, depth: number): Promise<KnowledgeEntity[]>;
}

// Knowledge graph manager
export class KnowledgeGraphManager {
  private storageAdapter: IKnowledgeGraphStorageAdapter;
  private workspaceId: string;

  constructor(storageAdapter: IKnowledgeGraphStorageAdapter, workspaceId: string) {
    this.storageAdapter = storageAdapter;
    this.workspaceId = workspaceId;
  }

  // Store extracted facts as knowledge graph entities and relationships
  async storeFacts(extractedFacts: ExtractedFact[]): Promise<string[]> {
    const storedFactIds: string[] = [];

    for (const extractedFact of extractedFacts) {
      const factId = `fact_${crypto.randomUUID()}`;

      // Create entities
      const entities: KnowledgeEntity[] = [];
      for (const entityData of extractedFact.entities) {
        const entity: KnowledgeEntity = {
          id: `entity_${crypto.randomUUID()}`,
          type: entityData.type,
          name: entityData.name,
          attributes: entityData.attributes,
          confidence: extractedFact.confidence,
          source: extractedFact.context,
          timestamp: new Date(),
          workspaceId: this.workspaceId,
        };
        entities.push(entity);
        await this.storageAdapter.storeEntity(entity);
      }

      // Create relationships
      const relationships: KnowledgeRelationship[] = [];
      for (const relData of extractedFact.relationships) {
        const sourceEntity = entities.find((e) => e.name === relData.source);
        const targetEntity = entities.find((e) => e.name === relData.target);

        if (sourceEntity && targetEntity) {
          const relationship: KnowledgeRelationship = {
            id: `rel_${crypto.randomUUID()}`,
            type: relData.type,
            sourceEntityId: sourceEntity.id,
            targetEntityId: targetEntity.id,
            attributes: relData.attributes,
            confidence: extractedFact.confidence,
            source: extractedFact.context,
            timestamp: new Date(),
            workspaceId: this.workspaceId,
          };
          relationships.push(relationship);
          await this.storageAdapter.storeRelationship(relationship);
        }
      }

      // Create fact
      const fact: KnowledgeFact = {
        id: factId,
        statement: extractedFact.statement,
        entities,
        relationships,
        confidence: extractedFact.confidence,
        source: extractedFact.context,
        timestamp: new Date(),
        workspaceId: this.workspaceId,
        tags: [extractedFact.type, "extracted_fact"],
        validated: false,
      };

      await this.storageAdapter.storeFact(fact);
      storedFactIds.push(factId);
    }

    return storedFactIds;
  }

  // Query knowledge graph
  async queryKnowledge(query: KnowledgeGraphQuery): Promise<{
    entities: KnowledgeEntity[];
    relationships: KnowledgeRelationship[];
    facts: KnowledgeFact[];
  }> {
    const entities = await this.storageAdapter.queryEntities({
      ...query,
      workspaceId: this.workspaceId,
    });
    const relationships = await this.storageAdapter.queryRelationships({
      ...query,
      workspaceId: this.workspaceId,
    });
    const facts = await this.storageAdapter.queryFacts({ ...query, workspaceId: this.workspaceId });

    return { entities, relationships, facts };
  }

  // Find related facts for a given entity
  async getRelatedFacts(entityName: string): Promise<KnowledgeFact[]> {
    const entities = await this.storageAdapter.queryEntities({
      entityNames: [entityName],
      workspaceId: this.workspaceId,
    });

    if (entities.length === 0) return [];

    const facts = await this.storageAdapter.queryFacts({
      workspaceId: this.workspaceId,
    });

    return facts.filter((fact) =>
      fact.entities.some((entity) => entity.name.toLowerCase() === entityName.toLowerCase())
    );
  }

  // Get workspace knowledge summary
  async getWorkspaceKnowledgeSummary(): Promise<{
    totalEntities: number;
    totalRelationships: number;
    totalFacts: number;
    entityTypes: Record<KnowledgeEntityType, number>;
    relationshipTypes: Record<KnowledgeRelationType, number>;
  }> {
    const entities = await this.storageAdapter.queryEntities({ workspaceId: this.workspaceId });
    const relationships = await this.storageAdapter.queryRelationships({
      workspaceId: this.workspaceId,
    });
    const facts = await this.storageAdapter.queryFacts({ workspaceId: this.workspaceId });

    const entityTypes: Record<KnowledgeEntityType, number> = {} as any;
    const relationshipTypes: Record<KnowledgeRelationType, number> = {} as any;

    entities.forEach((entity) => {
      entityTypes[entity.type] = (entityTypes[entity.type] || 0) + 1;
    });

    relationships.forEach((rel) => {
      relationshipTypes[rel.type] = (relationshipTypes[rel.type] || 0) + 1;
    });

    return {
      totalEntities: entities.length,
      totalRelationships: relationships.length,
      totalFacts: facts.length,
      entityTypes,
      relationshipTypes,
    };
  }
}
