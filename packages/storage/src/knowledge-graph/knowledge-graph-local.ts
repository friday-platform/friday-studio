/**
 * Local File Storage Adapter for Knowledge Graph
 * Stores knowledge graph data in JSON files with indexing
 */

import { ensureDir } from "@std/fs";
import type {
  IKnowledgeGraphStorageAdapter,
  KnowledgeEntity,
  KnowledgeFact,
  KnowledgeGraphQuery,
  KnowledgeRelationship,
} from "../types/core.ts";

export class KnowledgeGraphLocalStorageAdapter implements IKnowledgeGraphStorageAdapter {
  private basePath: string;
  private entitiesFile: string;
  private relationshipsFile: string;
  private factsFile: string;
  private indexFile: string;

  constructor(basePath: string) {
    this.basePath = basePath;
    this.entitiesFile = `${basePath}/knowledge-entities.json`;
    this.relationshipsFile = `${basePath}/knowledge-relationships.json`;
    this.factsFile = `${basePath}/knowledge-facts.json`;
    this.indexFile = `${basePath}/knowledge-index.json`;
  }

  private async ensureDirectory(): Promise<void> {
    await ensureDir(this.basePath);
  }

  private async readJsonFile<T>(filePath: string): Promise<Record<string, T>> {
    try {
      const content = await Deno.readTextFile(filePath);
      return JSON.parse(content);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return {};
      }
      throw error;
    }
  }

  private async writeJsonFile<T>(filePath: string, data: Record<string, T>): Promise<void> {
    await this.ensureDirectory();
    await Deno.writeTextFile(filePath, JSON.stringify(data, null, 2));
  }

  // Entity operations
  async storeEntity(entity: KnowledgeEntity): Promise<void> {
    const entities = await this.readJsonFile<KnowledgeEntity>(this.entitiesFile);
    entities[entity.id] = entity;
    await this.writeJsonFile(this.entitiesFile, entities);
    await this.updateIndex("entity", entity.id, entity.name, entity.type, entity.workspaceId);
  }

  async getEntity(id: string): Promise<KnowledgeEntity | null> {
    const entities = await this.readJsonFile<KnowledgeEntity>(this.entitiesFile);
    return entities[id] || null;
  }

  async queryEntities(query: KnowledgeGraphQuery): Promise<KnowledgeEntity[]> {
    const entities = await this.readJsonFile<KnowledgeEntity>(this.entitiesFile);
    const results = Object.values(entities).filter((entity) => {
      if (query.workspaceId && entity.workspaceId !== query.workspaceId) return false;
      if (query.entityTypes && !query.entityTypes.includes(entity.type)) return false;
      if (
        query.entityNames &&
        !query.entityNames.some((name) => entity.name.toLowerCase().includes(name.toLowerCase()))
      )
        return false;
      if (query.minConfidence && entity.confidence < query.minConfidence) return false;
      if (query.search && !this.entityMatchesSearch(entity, query.search)) return false;
      return true;
    });

    return query.limit ? results.slice(0, query.limit) : results;
  }

  async updateEntity(id: string, updates: Partial<KnowledgeEntity>): Promise<void> {
    const entities = await this.readJsonFile<KnowledgeEntity>(this.entitiesFile);
    if (entities[id]) {
      entities[id] = { ...entities[id], ...updates };
      await this.writeJsonFile(this.entitiesFile, entities);
    }
  }

  async deleteEntity(id: string): Promise<void> {
    const entities = await this.readJsonFile<KnowledgeEntity>(this.entitiesFile);
    delete entities[id];
    await this.writeJsonFile(this.entitiesFile, entities);
    await this.removeFromIndex("entity", id);
  }

  // Relationship operations
  async storeRelationship(relationship: KnowledgeRelationship): Promise<void> {
    const relationships = await this.readJsonFile<KnowledgeRelationship>(this.relationshipsFile);
    relationships[relationship.id] = relationship;
    await this.writeJsonFile(this.relationshipsFile, relationships);
    await this.updateIndex(
      "relationship",
      relationship.id,
      `${relationship.sourceEntityId}-${relationship.type}-${relationship.targetEntityId}`,
      relationship.type,
      relationship.workspaceId,
    );
  }

  async getRelationship(id: string): Promise<KnowledgeRelationship | null> {
    const relationships = await this.readJsonFile<KnowledgeRelationship>(this.relationshipsFile);
    return relationships[id] || null;
  }

  async queryRelationships(query: KnowledgeGraphQuery): Promise<KnowledgeRelationship[]> {
    const relationships = await this.readJsonFile<KnowledgeRelationship>(this.relationshipsFile);
    const results = Object.values(relationships).filter((rel) => {
      if (query.workspaceId && rel.workspaceId !== query.workspaceId) return false;
      if (query.relationshipTypes && !query.relationshipTypes.includes(rel.type)) return false;
      if (query.minConfidence && rel.confidence < query.minConfidence) return false;
      return true;
    });

    return query.limit ? results.slice(0, query.limit) : results;
  }

  async getEntityRelationships(entityId: string): Promise<KnowledgeRelationship[]> {
    const relationships = await this.readJsonFile<KnowledgeRelationship>(this.relationshipsFile);
    return Object.values(relationships).filter(
      (rel) => rel.sourceEntityId === entityId || rel.targetEntityId === entityId,
    );
  }

  async deleteRelationship(id: string): Promise<void> {
    const relationships = await this.readJsonFile<KnowledgeRelationship>(this.relationshipsFile);
    delete relationships[id];
    await this.writeJsonFile(this.relationshipsFile, relationships);
    await this.removeFromIndex("relationship", id);
  }

  // Fact operations
  async storeFact(fact: KnowledgeFact): Promise<void> {
    const facts = await this.readJsonFile<KnowledgeFact>(this.factsFile);
    facts[fact.id] = fact;
    await this.writeJsonFile(this.factsFile, facts);
    await this.updateIndex("fact", fact.id, fact.statement, "fact", fact.workspaceId);
  }

  async getFact(id: string): Promise<KnowledgeFact | null> {
    const facts = await this.readJsonFile<KnowledgeFact>(this.factsFile);
    return facts[id] || null;
  }

  async queryFacts(query: KnowledgeGraphQuery): Promise<KnowledgeFact[]> {
    const facts = await this.readJsonFile<KnowledgeFact>(this.factsFile);
    const results = Object.values(facts).filter((fact) => {
      if (query.workspaceId && fact.workspaceId !== query.workspaceId) return false;
      if (query.minConfidence && fact.confidence < query.minConfidence) return false;
      if (query.search && !this.factMatchesSearch(fact, query.search)) return false;
      return true;
    });

    return query.limit ? results.slice(0, query.limit) : results;
  }

  async deleteFact(id: string): Promise<void> {
    const facts = await this.readJsonFile<KnowledgeFact>(this.factsFile);
    delete facts[id];
    await this.writeJsonFile(this.factsFile, facts);
    await this.removeFromIndex("fact", id);
  }

  // Graph operations
  async findPaths(
    sourceEntityId: string,
    targetEntityId: string,
    maxDepth: number,
  ): Promise<KnowledgeRelationship[][]> {
    const relationships = await this.readJsonFile<KnowledgeRelationship>(this.relationshipsFile);
    const allRels = Object.values(relationships);

    // Simple BFS path finding
    const paths: KnowledgeRelationship[][] = [];
    const visited = new Set<string>();

    const findPathsRecursive = (
      currentId: string,
      targetId: string,
      currentPath: KnowledgeRelationship[],
      depth: number,
    ) => {
      if (depth > maxDepth) return;
      if (currentId === targetId && currentPath.length > 0) {
        paths.push([...currentPath]);
        return;
      }

      visited.add(currentId);

      for (const rel of allRels) {
        let nextId: string | null = null;
        if (rel.sourceEntityId === currentId && !visited.has(rel.targetEntityId)) {
          nextId = rel.targetEntityId;
        } else if (rel.targetEntityId === currentId && !visited.has(rel.sourceEntityId)) {
          nextId = rel.sourceEntityId;
        }

        if (nextId) {
          findPathsRecursive(nextId, targetId, [...currentPath, rel], depth + 1);
        }
      }

      visited.delete(currentId);
    };

    findPathsRecursive(sourceEntityId, targetEntityId, [], 0);
    return paths;
  }

  async getNeighbors(entityId: string, depth: number): Promise<KnowledgeEntity[]> {
    const relationships = await this.queryRelationships({});
    const entities = await this.readJsonFile<KnowledgeEntity>(this.entitiesFile);

    const neighborIds = new Set<string>();
    const visited = new Set<string>();

    const findNeighborsRecursive = (currentId: string, currentDepth: number) => {
      if (currentDepth > depth) return;
      visited.add(currentId);

      for (const rel of relationships) {
        let neighborId: string | null = null;
        if (rel.sourceEntityId === currentId) {
          neighborId = rel.targetEntityId;
        } else if (rel.targetEntityId === currentId) {
          neighborId = rel.sourceEntityId;
        }

        if (neighborId && !visited.has(neighborId)) {
          neighborIds.add(neighborId);
          if (currentDepth < depth) {
            findNeighborsRecursive(neighborId, currentDepth + 1);
          }
        }
      }
    };

    findNeighborsRecursive(entityId, 0);

    return Array.from(neighborIds)
      .map((id) => entities[id])
      .filter((entity): entity is KnowledgeEntity => entity !== undefined);
  }

  // Helper methods
  private entityMatchesSearch(entity: KnowledgeEntity, search: string): boolean {
    const searchLower = search.toLowerCase();
    return (
      entity.name.toLowerCase().includes(searchLower) ||
      JSON.stringify(entity.attributes).toLowerCase().includes(searchLower)
    );
  }

  private factMatchesSearch(fact: KnowledgeFact, search: string): boolean {
    const searchLower = search.toLowerCase();
    return (
      fact.statement.toLowerCase().includes(searchLower) ||
      fact.tags.some((tag) => tag.toLowerCase().includes(searchLower))
    );
  }

  // Index management for faster queries
  private async updateIndex(
    type: string,
    id: string,
    searchText: string,
    subType: string,
    workspaceId: string,
  ): Promise<void> {
    const index = await this.readJsonFile(this.indexFile);
    if (!index[workspaceId]) index[workspaceId] = {};
    if (!index[workspaceId][type]) index[workspaceId][type] = {};

    index[workspaceId][type][id] = {
      searchText: searchText.toLowerCase(),
      subType,
      timestamp: new Date().toISOString(),
    };

    await this.writeJsonFile(this.indexFile, index);
  }

  private async removeFromIndex(type: string, id: string): Promise<void> {
    const index = await this.readJsonFile(this.indexFile);
    for (const workspaceId in index) {
      if (index[workspaceId][type]) {
        delete index[workspaceId][type][id];
      }
    }
    await this.writeJsonFile(this.indexFile, index);
  }
}
