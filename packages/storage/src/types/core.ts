/**
 * Core storage interfaces and types for Atlas storage adapters
 */

// Legacy memory storage interface
export interface ITempestMemoryStorageAdapter {
  commit(data: any): Promise<void>;
  load(): Promise<any>;
}

// Enhanced storage adapter for CoALA memory types
export interface ICoALAMemoryStorageAdapter extends ITempestMemoryStorageAdapter {
  commitByType(memoryType: string, data: any): Promise<void>;
  loadByType(memoryType: string): Promise<any>;
  commitAll(dataByType: Record<string, any>): Promise<void>;
  loadAll(): Promise<Record<string, any>>;
  listMemoryTypes(): Promise<string[]>;
}

// Knowledge graph storage types
export interface KnowledgeEntity {
  id: string;
  name: string;
  type: KnowledgeEntityType;
  attributes: Record<string, any>;
  confidence: number;
  workspaceId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeRelationship {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  type: KnowledgeRelationType;
  attributes: Record<string, any>;
  confidence: number;
  workspaceId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeFact {
  id: string;
  statement: string;
  confidence: number;
  tags: string[];
  workspaceId: string;
  createdAt: Date;
  updatedAt: Date;
}

export enum KnowledgeEntityType {
  PERSON = "person",
  ORGANIZATION = "organization",
  LOCATION = "location",
  CONCEPT = "concept",
  TECHNOLOGY = "technology",
  PROJECT = "project",
  DOCUMENT = "document",
  FILE = "file",
  SYSTEM = "system",
  PROCESS = "process",
  UNKNOWN = "unknown",
}

export enum KnowledgeRelationType {
  WORKS_FOR = "works_for",
  LOCATED_IN = "located_in",
  PART_OF = "part_of",
  USES = "uses",
  DEPENDS_ON = "depends_on",
  CREATES = "creates",
  MANAGES = "manages",
  COLLABORATES_WITH = "collaborates_with",
  IMPLEMENTS = "implements",
  RELATES_TO = "relates_to",
  SIMILAR_TO = "similar_to",
  OPPOSITE_OF = "opposite_of",
  CAUSES = "causes",
  UNKNOWN = "unknown",
}

export interface KnowledgeGraphQuery {
  workspaceId?: string;
  entityTypes?: KnowledgeEntityType[];
  relationshipTypes?: KnowledgeRelationType[];
  entityNames?: string[];
  minConfidence?: number;
  search?: string;
  limit?: number;
}

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
