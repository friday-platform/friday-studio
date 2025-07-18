/**
 * Mock storage implementations for memory integration tests
 * Simple in-memory implementations that don't require complex setup
 */

import type {
  ICoALAMemoryStorageAdapter,
  IKnowledgeGraphStorageAdapter,
  ITempestMemoryStorageAdapter,
  KnowledgeEntity,
  KnowledgeFact,
  KnowledgeGraphQuery,
  KnowledgeRelationship,
} from "@atlas/storage";

/**
 * Simple mock storage adapter for memory testing
 */
export class MockMemoryStorageAdapter
  implements ICoALAMemoryStorageAdapter, ITempestMemoryStorageAdapter {
  private data = new Map<string, any>();

  async store(key: string, value: any): Promise<void> {
    this.data.set(key, value);
  }

  async retrieve(key: string): Promise<any | null> {
    return this.data.get(key) || null;
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(): Promise<string[]> {
    return Array.from(this.data.keys());
  }

  async clear(): Promise<void> {
    this.data.clear();
  }

  async exists(key: string): Promise<boolean> {
    return this.data.has(key);
  }

  async batchStore(entries: Array<{ key: string; value: any }>): Promise<void> {
    entries.forEach(({ key, value }) => {
      this.data.set(key, value);
    });
  }

  // CoALA specific methods
  async storeMemoryByType(memoryType: string, key: string, value: any): Promise<void> {
    const typeKey = `${memoryType}:${key}`;
    this.data.set(typeKey, value);
  }

  async retrieveMemoryByType(memoryType: string, key: string): Promise<any | null> {
    const typeKey = `${memoryType}:${key}`;
    return this.data.get(typeKey) || null;
  }

  async getMemoryTypeKeys(memoryType: string): Promise<string[]> {
    const prefix = `${memoryType}:`;
    return Array.from(this.data.keys())
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.substring(prefix.length));
  }

  async getAllMemoryTypes(): Promise<string[]> {
    const types = new Set<string>();
    for (const key of this.data.keys()) {
      const colonIndex = key.indexOf(":");
      if (colonIndex !== -1) {
        types.add(key.substring(0, colonIndex));
      }
    }
    return Array.from(types);
  }

  async clearMemoryType(memoryType: string): Promise<void> {
    const prefix = `${memoryType}:`;
    const keysToDelete = Array.from(this.data.keys()).filter((key) => key.startsWith(prefix));
    keysToDelete.forEach((key) => this.data.delete(key));
  }

  // CoALA compaction methods
  async compactMemories(): Promise<void> {
    // Mock implementation - no actual compaction needed
  }

  async getStorageStats(): Promise<any> {
    return {
      totalMemories: this.data.size,
      memoryTypes: await this.getAllMemoryTypes(),
      storageSize: JSON.stringify(Array.from(this.data.entries())).length,
    };
  }

  async commitAll(): Promise<void> {
    // Mock implementation - data is already "committed"
  }

  async loadAll(): Promise<Map<string, any>> {
    return new Map(this.data);
  }

  // Helper method for tests
  getAllData(): Map<string, any> {
    return new Map(this.data);
  }
}

/**
 * Mock knowledge graph storage adapter
 */
export class MockKnowledgeGraphStorageAdapter implements IKnowledgeGraphStorageAdapter {
  private entities = new Map<string, KnowledgeEntity>();
  private relationships = new Map<string, KnowledgeRelationship>();
  private facts = new Map<string, KnowledgeFact>();

  // Entity operations
  async storeEntity(entity: KnowledgeEntity): Promise<void> {
    this.entities.set(entity.id, entity);
  }

  async getEntity(id: string): Promise<KnowledgeEntity | null> {
    return this.entities.get(id) || null;
  }

  async queryEntities(query: KnowledgeGraphQuery): Promise<KnowledgeEntity[]> {
    return Array.from(this.entities.values()).filter((entity) => {
      if (query.workspaceId && entity.workspaceId !== query.workspaceId) return false;
      if (query.entityTypes && !query.entityTypes.includes(entity.type)) return false;
      if (
        query.entityNames &&
        !query.entityNames.some((name) => entity.name.toLowerCase().includes(name.toLowerCase()))
      ) return false;
      if (query.minConfidence && entity.confidence < query.minConfidence) return false;
      if (query.search && !this.entityMatchesSearch(entity, query.search)) return false;
      return true;
    }).slice(0, query.limit || 100);
  }

  async updateEntity(id: string, updates: Partial<KnowledgeEntity>): Promise<void> {
    const entity = this.entities.get(id);
    if (entity) {
      this.entities.set(id, { ...entity, ...updates });
    }
  }

  async deleteEntity(id: string): Promise<void> {
    this.entities.delete(id);
  }

  // Relationship operations
  async storeRelationship(relationship: KnowledgeRelationship): Promise<void> {
    this.relationships.set(relationship.id, relationship);
  }

  async getRelationship(id: string): Promise<KnowledgeRelationship | null> {
    return this.relationships.get(id) || null;
  }

  async queryRelationships(query: KnowledgeGraphQuery): Promise<KnowledgeRelationship[]> {
    return Array.from(this.relationships.values()).filter((rel) => {
      if (query.workspaceId && rel.workspaceId !== query.workspaceId) return false;
      if (query.relationshipTypes && !query.relationshipTypes.includes(rel.type)) return false;
      if (query.minConfidence && rel.confidence < query.minConfidence) return false;
      return true;
    }).slice(0, query.limit || 100);
  }

  async getEntityRelationships(entityId: string): Promise<KnowledgeRelationship[]> {
    return Array.from(this.relationships.values()).filter((rel) =>
      rel.sourceEntityId === entityId || rel.targetEntityId === entityId
    );
  }

  async deleteRelationship(id: string): Promise<void> {
    this.relationships.delete(id);
  }

  // Fact operations
  async storeFact(fact: KnowledgeFact): Promise<void> {
    this.facts.set(fact.id, fact);
  }

  async getFact(id: string): Promise<KnowledgeFact | null> {
    return this.facts.get(id) || null;
  }

  async queryFacts(query: KnowledgeGraphQuery): Promise<KnowledgeFact[]> {
    return Array.from(this.facts.values()).filter((fact) => {
      if (query.workspaceId && fact.workspaceId !== query.workspaceId) return false;
      if (query.minConfidence && fact.confidence < query.minConfidence) return false;
      if (query.search && !this.factMatchesSearch(fact, query.search)) return false;
      return true;
    }).slice(0, query.limit || 100);
  }

  async deleteFact(id: string): Promise<void> {
    this.facts.delete(id);
  }

  // Graph operations
  async findPaths(
    sourceEntityId: string,
    targetEntityId: string,
    maxDepth: number,
  ): Promise<KnowledgeRelationship[][]> {
    const paths: KnowledgeRelationship[][] = [];
    const visited = new Set<string>();
    const relationships = Array.from(this.relationships.values());

    const findPathsRecursive = (
      currentId: string,
      targetId: string,
      currentPath: KnowledgeRelationship[],
      currentDepth: number,
    ) => {
      if (currentDepth > maxDepth) return;
      if (currentId === targetId && currentPath.length > 0) {
        paths.push([...currentPath]);
        return;
      }

      visited.add(currentId);

      for (const rel of relationships) {
        let nextId: string | null = null;
        if (rel.sourceEntityId === currentId && !visited.has(rel.targetEntityId)) {
          nextId = rel.targetEntityId;
        } else if (rel.targetEntityId === currentId && !visited.has(rel.sourceEntityId)) {
          nextId = rel.sourceEntityId;
        }

        if (nextId) {
          findPathsRecursive(nextId, targetId, [...currentPath, rel], currentDepth + 1);
        }
      }

      visited.delete(currentId);
    };

    findPathsRecursive(sourceEntityId, targetEntityId, [], 0);
    return paths;
  }

  async getNeighbors(entityId: string, depth: number): Promise<KnowledgeEntity[]> {
    const neighborIds = new Set<string>();
    const visited = new Set<string>();
    const relationships = Array.from(this.relationships.values());

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
    return Array.from(neighborIds).map((id) => this.entities.get(id)!).filter(Boolean);
  }

  // Helper methods
  private entityMatchesSearch(entity: KnowledgeEntity, search: string): boolean {
    const searchLower = search.toLowerCase();
    return entity.name.toLowerCase().includes(searchLower) ||
      JSON.stringify(entity.attributes).toLowerCase().includes(searchLower);
  }

  private factMatchesSearch(fact: KnowledgeFact, search: string): boolean {
    const searchLower = search.toLowerCase();
    return fact.statement.toLowerCase().includes(searchLower) ||
      fact.tags.some((tag) => tag.toLowerCase().includes(searchLower));
  }

  // Helper methods for tests
  getAllEntities(): Map<string, KnowledgeEntity> {
    return new Map(this.entities);
  }

  getAllRelationships(): Map<string, KnowledgeRelationship> {
    return new Map(this.relationships);
  }

  getAllFacts(): Map<string, KnowledgeFact> {
    return new Map(this.facts);
  }

  clear(): void {
    this.entities.clear();
    this.relationships.clear();
    this.facts.clear();
  }
}

/**
 * Mock LLM provider for testing (prevents actual LLM calls)
 */
export class MockLLMProvider {
  private responses = new Map<string, string>();

  setResponse(prompt: string, response: string): void {
    this.responses.set(prompt, response);
  }

  async generate(prompt: string): Promise<string> {
    // Return predefined response or empty facts array
    return this.responses.get(prompt) || "[]";
  }

  clear(): void {
    this.responses.clear();
  }
}

/**
 * Simple mock AtlasScope for testing
 */
export class MockAtlasScope {
  id: string;

  constructor(id?: string) {
    this.id = id || crypto.randomUUID();
  }

  // Mock methods that tests might expect
  newConversation(): any {
    return {};
  }

  getConversation(): any {
    return {};
  }

  archiveConversation(): void {}
  deleteConversation(): void {}
}
