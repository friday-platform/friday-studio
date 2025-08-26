/**
 * Knowledge Graph Implementation for Semantic Memory
 * Enhances semantic memory to work as a structured knowledge base
 */

import type {
  KnowledgeEntity as StorageKnowledgeEntity,
  KnowledgeFact as StorageKnowledgeFact,
  KnowledgeGraphQuery as StorageKnowledgeGraphQuery,
  KnowledgeRelationship as StorageKnowledgeRelationship,
} from "@atlas/storage";
import { KnowledgeEntityType, KnowledgeRelationType } from "@atlas/storage";

// Re-export storage types for compatibility
export { KnowledgeEntityType, KnowledgeRelationType };

// Extended knowledge graph types with memory-specific properties
export interface KnowledgeEntity extends StorageKnowledgeEntity {
  source: string; // Where this entity was extracted from
  timestamp: Date;
}

export interface KnowledgeRelationship extends StorageKnowledgeRelationship {
  source: string;
  timestamp: Date;
}

export interface KnowledgeFact extends StorageKnowledgeFact {
  entities: KnowledgeEntity[];
  relationships: KnowledgeRelationship[];
  source: string;
  timestamp: Date;
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
  entities: { type: KnowledgeEntityType; name: string; attributes: Record<string, any> }[];
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
// Knowledge graph query interface - use storage interface
export interface KnowledgeGraphQuery extends StorageKnowledgeGraphQuery {}

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
        const now = new Date();
        const entity: KnowledgeEntity = {
          id: `entity_${crypto.randomUUID()}`,
          type: entityData.type,
          name: entityData.name,
          attributes: entityData.attributes,
          confidence: extractedFact.confidence,
          source: extractedFact.context,
          timestamp: now,
          workspaceId: this.workspaceId,
          createdAt: now,
          updatedAt: now,
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
          const relationshipNow = new Date();
          const relationship: KnowledgeRelationship = {
            id: `rel_${crypto.randomUUID()}`,
            type: relData.type,
            sourceEntityId: sourceEntity.id,
            targetEntityId: targetEntity.id,
            attributes: relData.attributes,
            confidence: extractedFact.confidence,
            source: extractedFact.context,
            timestamp: relationshipNow,
            workspaceId: this.workspaceId,
            createdAt: relationshipNow,
            updatedAt: relationshipNow,
          };
          relationships.push(relationship);
          await this.storageAdapter.storeRelationship(relationship);
        }
      }

      // Create fact
      const factNow = new Date();
      const fact: KnowledgeFact = {
        id: factId,
        statement: extractedFact.statement,
        entities,
        relationships,
        confidence: extractedFact.confidence,
        source: extractedFact.context,
        timestamp: factNow,
        workspaceId: this.workspaceId,
        tags: [extractedFact.type, "extracted_fact"],
        validated: false,
        createdAt: factNow,
        updatedAt: factNow,
      };

      await this.storageAdapter.storeFact(fact);
      storedFactIds.push(factId);
    }

    return storedFactIds;
  }

  // Query knowledge graph
  async queryKnowledge(
    query: KnowledgeGraphQuery,
  ): Promise<{
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

    const facts = await this.storageAdapter.queryFacts({ workspaceId: this.workspaceId });

    return facts.filter((fact) =>
      fact.entities.some((entity) => entity.name.toLowerCase() === entityName.toLowerCase()),
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

    const entityTypes: Record<KnowledgeEntityType, number> = {
      [KnowledgeEntityType.PERSON]: 0,
      [KnowledgeEntityType.PROJECT]: 0,
      [KnowledgeEntityType.SERVICE]: 0,
      [KnowledgeEntityType.CONCEPT]: 0,
      [KnowledgeEntityType.PREFERENCE]: 0,
      [KnowledgeEntityType.IDENTIFIER]: 0,
      [KnowledgeEntityType.TEAM]: 0,
      [KnowledgeEntityType.TECHNOLOGY]: 0,
      [KnowledgeEntityType.LOCATION]: 0,
      [KnowledgeEntityType.FACT]: 0,
    };
    const relationshipTypes: Record<KnowledgeRelationType, number> = {
      [KnowledgeRelationType.IS_A]: 0,
      [KnowledgeRelationType.PART_OF]: 0,
      [KnowledgeRelationType.WORKS_ON]: 0,
      [KnowledgeRelationType.USES]: 0,
      [KnowledgeRelationType.PREFERS]: 0,
      [KnowledgeRelationType.OWNS]: 0,
      [KnowledgeRelationType.MEMBER_OF]: 0,
      [KnowledgeRelationType.LOCATED_AT]: 0,
      [KnowledgeRelationType.RELATED_TO]: 0,
      [KnowledgeRelationType.HAS_ATTRIBUTE]: 0,
      [KnowledgeRelationType.KNOWS]: 0,
    };

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
