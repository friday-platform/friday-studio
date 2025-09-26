/**
 * Core storage interfaces and types for Atlas storage adapters
 */

import type { CoALAMemoryEntry, CoALAMemoryType } from "@atlas/memory";

// Enhanced storage adapter for CoALA memory types
export interface ICoALAMemoryStorageAdapter {
  commitByType(memoryType: CoALAMemoryType, data: CoALAMemoryEntry[]): Promise<void>;
  loadByType(memoryType: CoALAMemoryType): Promise<CoALAMemoryEntry[]>;
  commitAll(dataByType: Record<CoALAMemoryType, CoALAMemoryEntry[]>): Promise<void>;
  loadAll(): Promise<Record<CoALAMemoryType, CoALAMemoryEntry[]>>;
  listMemoryTypes(): CoALAMemoryType[];
}

// Knowledge graph storage types
export interface KnowledgeEntity {
  id: string;
  name: string;
  type: KnowledgeEntityType;
  attributes: Record<string, unknown>;
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
  attributes: Record<string, unknown>;
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
