/**
 * Library Storage Adapter - Hybrid Approach
 *
 * Domain-specific storage adapter for library operations using hybrid storage:
 * - Metadata stored in KV for fast querying and indexing
 * - Content stored on disk for efficient handling of large files
 * - Configurable storage locations with standard CLI patterns
 *
 * Built on top of the KVStorage interface to provide semantic library operations
 * while maintaining complete storage backend independence.
 */

import { dirname, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { type KVStorage } from "./kv-storage.ts";
import {
  type LibraryItem,
  type LibrarySearchQuery,
  type LibrarySearchResult,
  type LibraryStats,
  type TemplateConfig,
} from "../library/types.ts";
import { z } from "zod/v4";

/**
 * Library storage configuration
 */
export interface LibraryStorageConfig {
  /** Base directory for content storage. Defaults to ~/.atlas/library */
  contentDir?: string;
  /** Whether to organize content by type subdirectories */
  organizeByType?: boolean;
  /** Whether to organize content by date subdirectories (YYYY/MM) */
  organizeByDate?: boolean;
  /** File extension mapping for content types */
  extensionMap?: Record<string, string>;
}

/**
 * Get default library storage directory following XDG Base Directory specification
 */
function getDefaultLibraryDir(): string {
  // Implement XDG Base Directory specification manually
  if (Deno.build.os === "windows") {
    // Windows: Use LOCALAPPDATA or APPDATA
    const localAppData = Deno.env.get("LOCALAPPDATA");
    if (localAppData) {
      return join(localAppData, "Atlas", "library");
    }
    const appData = Deno.env.get("APPDATA");
    if (appData) {
      return join(appData, "Atlas", "library");
    }
  } else if (Deno.build.os === "darwin") {
    // macOS: Use ~/Library/Application Support
    const homeDir = Deno.env.get("HOME");
    if (homeDir) {
      return join(homeDir, "Library", "Application Support", "Atlas", "library");
    }
  } else {
    // Linux/Unix: Use XDG_DATA_HOME or ~/.local/share
    const xdgDataHome = Deno.env.get("XDG_DATA_HOME");
    if (xdgDataHome) {
      return join(xdgDataHome, "atlas", "library");
    }
    const homeDir = Deno.env.get("HOME");
    if (homeDir) {
      return join(homeDir, ".local", "share", "atlas", "library");
    }
  }

  // Fallback to current directory
  return join(Deno.cwd(), ".atlas", "library");
}

/**
 * Library item for KV storage (metadata only)
 */
interface LibraryMetadata {
  id: string;
  type: LibraryItem["type"];
  name: string;
  description?: string;
  content_path: string;
  metadata: LibraryItem["metadata"];
  created_at: string;
  updated_at: string;
  tags: string[];
  size_bytes: number;
  workspace_id?: string;
}

// Schema for validating library item data (for future use)
// const LibraryItemStoreSchema = z.object({
//   id: z.string(),
//   type: z.string(),
//   name: z.string(),
//   description: z.string().optional(),
//   content: z.union([z.string(), z.instanceof(Uint8Array)]),
//   metadata: z.object({
//     format: z.string(),
//     source: z.string(),
//     session_id: z.string().optional(),
//     agent_ids: z.array(z.string()).optional(),
//     custom_fields: z.record(z.string(), z.unknown()).optional(),
//   }),
//   created_at: z.string(),
//   updated_at: z.string(),
//   tags: z.array(z.string()),
//   workspace_id: z.string().optional(),
// });

/**
 * Library-specific storage operations with hybrid storage
 *
 * This adapter provides high-level library operations built on the
 * foundational KVStorage interface. It handles indexing, search,
 * and library-specific business logic using hybrid storage:
 * - Metadata in KV for fast queries
 * - Content on disk for efficient large file handling
 */
export class LibraryStorageAdapter {
  private readonly LIBRARY_VERSION = "1.0.0";
  private config: Required<LibraryStorageConfig>;
  private contentDir: string;

  constructor(private storage: KVStorage, config: LibraryStorageConfig = {}) {
    // Apply defaults to config
    this.config = {
      contentDir: config.contentDir || getDefaultLibraryDir(),
      organizeByType: config.organizeByType ?? true,
      organizeByDate: config.organizeByDate ?? true,
      extensionMap: {
        markdown: "md",
        json: "json",
        html: "html",
        text: "txt",
        binary: "bin",
        ...config.extensionMap,
      },
    };

    this.contentDir = join(this.config.contentDir, "content");
  }

  /**
   * Initialize the library storage
   * Sets up initial metadata, indexes, and content directories
   */
  async initialize(): Promise<void> {
    await this.storage.initialize();

    // Ensure content directory exists
    await ensureDir(this.contentDir);

    // Create organized subdirectories if configured
    if (this.config.organizeByType) {
      const typeNames = ["report", "session_archive", "template", "artifact", "user_upload"];
      for (const typeName of typeNames) {
        await ensureDir(join(this.contentDir, typeName));
      }
    }

    // Initialize library metadata if not exists
    const version = await this.storage.get<string>(["library", "version"]);
    if (!version) {
      const atomic = this.storage.atomic();
      atomic.set(["library", "version"], this.LIBRARY_VERSION);
      atomic.set(["library", "config"], this.config);
      atomic.set(["library", "lastUpdated"], new Date().toISOString());
      await atomic.commit();
    }
  }

  /**
   * Store a library item with automatic indexing (hybrid storage)
   */
  async storeItem(item: {
    id: string;
    type: string;
    name: string;
    description?: string;
    content: string | Uint8Array;
    metadata: LibraryItem["metadata"];
    created_at: string;
    updated_at: string;
    tags: string[];
    workspace_id?: string;
  }): Promise<void> {
    // Validate item structure (basic validation)
    if (!item.id || !item.type || !item.name || !item.content) {
      throw new Error("Missing required fields for library item");
    }

    // Calculate content size
    const contentSize = typeof item.content === "string"
      ? new TextEncoder().encode(item.content).length
      : item.content.length;

    // Generate content path using organized structure
    const contentPath = this.generateContentPath(
      item.id,
      item.type,
      item.metadata.format,
      item.created_at,
    );
    const fullContentPath = join(this.contentDir, contentPath);

    // Ensure content directory exists
    await ensureDir(dirname(fullContentPath));

    // Write content to disk
    if (typeof item.content === "string") {
      await Deno.writeTextFile(fullContentPath, item.content);
    } else {
      await Deno.writeFile(fullContentPath, item.content);
    }

    // Create metadata record for KV storage
    const metadata: LibraryMetadata = {
      id: item.id,
      type: item.type as LibraryItem["type"],
      name: item.name,
      description: item.description,
      content_path: contentPath,
      metadata: item.metadata,
      created_at: item.created_at,
      updated_at: item.updated_at,
      tags: item.tags,
      size_bytes: contentSize,
      workspace_id: item.workspace_id,
    };

    const atomic = this.storage.atomic();

    // Store metadata only in KV
    atomic.set(["library", "items", metadata.id], metadata);

    // Create indexes for efficient querying
    atomic.set(["library", "indexes", "by_type", metadata.type, metadata.id], metadata.id);

    for (const tag of metadata.tags) {
      atomic.set(["library", "indexes", "by_tag", tag, metadata.id], metadata.id);
    }

    if (metadata.workspace_id) {
      atomic.set(
        ["library", "indexes", "by_workspace", metadata.workspace_id, metadata.id],
        metadata.id,
      );
    }

    // Date-based index (YYYY-MM format for monthly grouping)
    const datePrefix = metadata.created_at.substring(0, 7); // YYYY-MM
    atomic.set(["library", "indexes", "by_date", datePrefix, metadata.id], metadata.id);

    // Update metadata
    atomic.set(["library", "lastUpdated"], new Date().toISOString());

    const success = await atomic.commit();
    if (!success) {
      // Clean up content file if KV operation failed
      try {
        await Deno.remove(fullContentPath);
      } catch {
        // Ignore cleanup errors
      }
      throw new Error("Failed to store library item - atomic operation failed");
    }
  }

  /**
   * Retrieve a library item by ID (hybrid storage)
   */
  async getItem(id: string): Promise<{ item: LibraryItem; content?: string | Uint8Array } | null> {
    const metadata = await this.storage.get<LibraryMetadata>(["library", "items", id]);
    if (!metadata) {
      return null;
    }

    // Convert metadata to LibraryItem format
    const item: LibraryItem = {
      ...metadata,
      content_path: metadata.content_path,
    };

    return { item };
  }

  /**
   * Retrieve a library item with content by ID
   */
  async getItemWithContent(
    id: string,
  ): Promise<{ item: LibraryItem; content: string | Uint8Array } | null> {
    const metadata = await this.storage.get<LibraryMetadata>(["library", "items", id]);
    if (!metadata) {
      return null;
    }

    // Read content from disk
    const fullContentPath = join(this.contentDir, metadata.content_path);

    let content: string | Uint8Array;
    try {
      if (metadata.metadata.format === "binary") {
        content = await Deno.readFile(fullContentPath);
      } else {
        content = await Deno.readTextFile(fullContentPath);
      }
    } catch (error) {
      throw new Error(
        `Failed to read content for item ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Convert metadata to LibraryItem format
    const item: LibraryItem = {
      ...metadata,
      content_path: metadata.content_path,
    };

    return { item, content };
  }

  /**
   * Delete a library item and its indexes (hybrid storage)
   */
  async deleteItem(id: string): Promise<boolean> {
    const metadata = await this.storage.get<LibraryMetadata>(["library", "items", id]);
    if (!metadata) {
      return false;
    }

    // Delete content file
    const fullContentPath = join(this.contentDir, metadata.content_path);
    try {
      await Deno.remove(fullContentPath);
    } catch (error) {
      // Log warning but continue with metadata deletion
      console.warn(
        `Failed to delete content file ${fullContentPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const atomic = this.storage.atomic();

    // Delete metadata
    atomic.delete(["library", "items", id]);

    // Delete indexes
    atomic.delete(["library", "indexes", "by_type", metadata.type, id]);

    for (const tag of metadata.tags) {
      atomic.delete(["library", "indexes", "by_tag", tag, id]);
    }

    if (metadata.workspace_id) {
      atomic.delete(["library", "indexes", "by_workspace", metadata.workspace_id, id]);
    }

    const datePrefix = metadata.created_at.substring(0, 7);
    atomic.delete(["library", "indexes", "by_date", datePrefix, id]);

    // Update metadata
    atomic.set(["library", "lastUpdated"], new Date().toISOString());

    const success = await atomic.commit();
    return success;
  }

  /**
   * Search library items based on query criteria
   */
  async search(query: LibrarySearchQuery): Promise<LibrarySearchResult> {
    const startTime = Date.now();
    const items: LibraryItem[] = [];

    // Use indexes for efficient querying when possible
    let candidateIds: Set<string> | null = null;

    // Filter by type if specified
    if (query.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      const typeIds = new Set<string>();

      for (const type of types) {
        for await (const { key } of this.storage.list(["library", "indexes", "by_type", type])) {
          if (key.length === 5) { // ['library', 'indexes', 'by_type', type, id]
            const itemId = key[4];
            if (typeof itemId === "string") {
              typeIds.add(itemId);
            }
          }
        }
      }

      candidateIds = typeIds;
    }

    // Filter by tags if specified
    if (query.tags && query.tags.length > 0) {
      const tagIds = new Set<string>();

      for (const tag of query.tags) {
        for await (const { key } of this.storage.list(["library", "indexes", "by_tag", tag])) {
          if (key.length === 5) { // ['library', 'indexes', 'by_tag', tag, id]
            const itemId = key[4];
            if (typeof itemId === "string") {
              tagIds.add(itemId);
            }
          }
        }
      }

      if (candidateIds) {
        // Intersection of type and tag filters
        candidateIds = new Set([...candidateIds].filter((id) => tagIds.has(id)));
      } else {
        candidateIds = tagIds;
      }
    }

    // Note: workspace filtering would need workspace_id parameter
    // The current LibrarySearchQuery only has a boolean 'workspace' field
    // This is a limitation of the current interface

    // If no specific filters, get all items
    if (!candidateIds) {
      for await (const { value } of this.storage.list<LibraryMetadata>(["library", "items"])) {
        if (value) {
          // Convert metadata to LibraryItem format
          const item: LibraryItem = { ...value };
          items.push(item);
        }
      }
    } else {
      // Fetch items by candidate IDs
      for (const id of candidateIds) {
        const metadata = await this.storage.get<LibraryMetadata>(["library", "items", id]);
        if (metadata) {
          // Convert metadata to LibraryItem format
          const item: LibraryItem = { ...metadata };
          items.push(item);
        }
      }
    }

    // Apply additional filters
    let filteredItems = items;

    // Date filter
    if (query.since) {
      const sinceDate = new Date(query.since);
      filteredItems = filteredItems.filter((item) => new Date(item.created_at) >= sinceDate);
    }

    if (query.until) {
      const untilDate = new Date(query.until);
      filteredItems = filteredItems.filter((item) => new Date(item.created_at) <= untilDate);
    }

    // Text search in name and description
    if (query.query) {
      const searchTerm = query.query.toLowerCase();
      filteredItems = filteredItems.filter((item) =>
        item.name.toLowerCase().includes(searchTerm) ||
        (item.description && item.description.toLowerCase().includes(searchTerm))
      );
    }

    // Sort by created_at (newest first)
    filteredItems.sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    // Apply pagination
    const offset = query.offset || 0;
    const limit = query.limit || 50;
    const paginatedItems = filteredItems.slice(offset, offset + limit);

    return {
      items: paginatedItems,
      total: filteredItems.length,
      query,
      took_ms: Date.now() - startTime,
    };
  }

  /**
   * List items with simple filtering
   */
  async listItems(options: {
    type?: string | string[];
    tags?: string[];
    workspace_id?: string;
    since?: string;
    limit?: number;
  } = {}): Promise<LibraryItem[]> {
    const query: LibrarySearchQuery = {
      type: options.type,
      tags: options.tags,
      // Note: workspace filtering not supported with current LibrarySearchQuery interface
      since: options.since,
      limit: options.limit || 50,
    };

    const result = await this.search(query);
    return result.items;
  }

  /**
   * Get library statistics
   */
  async getStats(): Promise<LibraryStats> {
    const items = await this.listItems({ limit: 10000 }); // Get all items for stats

    const typeBreakdown = new Map<string, number>();
    const tagBreakdown = new Map<string, number>();
    let totalSize = 0;

    for (const item of items) {
      // Type breakdown
      typeBreakdown.set(item.type, (typeBreakdown.get(item.type) || 0) + 1);

      // Tag breakdown
      for (const tag of item.tags) {
        tagBreakdown.set(tag, (tagBreakdown.get(tag) || 0) + 1);
      }

      totalSize += item.size_bytes;
    }

    return {
      total_items: items.length,
      total_size_bytes: totalSize,
      types: Object.fromEntries(typeBreakdown),
      recent_activity: [], // TODO: Implement activity tracking
    };
  }

  /**
   * Store a template configuration
   */
  async storeTemplate(template: TemplateConfig): Promise<void> {
    const atomic = this.storage.atomic();

    // Templates are global for now - workspace-specific templates would need interface extension
    atomic.set(["library", "templates", "global", template.id], template);

    atomic.set(["library", "lastUpdated"], new Date().toISOString());

    const success = await atomic.commit();
    if (!success) {
      throw new Error("Failed to store template - atomic operation failed");
    }
  }

  /**
   * Get a template by ID
   */
  async getTemplate(id: string, workspace_id?: string): Promise<TemplateConfig | null> {
    if (workspace_id) {
      const template = await this.storage.get<TemplateConfig>([
        "library",
        "templates",
        workspace_id,
        id,
      ]);
      if (template) return template;
    }

    // Fall back to global templates
    return await this.storage.get<TemplateConfig>(["library", "templates", "global", id]);
  }

  /**
   * List available templates
   */
  async listTemplates(workspace_id?: string): Promise<TemplateConfig[]> {
    const templates: TemplateConfig[] = [];

    // Get workspace-specific templates
    if (workspace_id) {
      for await (
        const { value } of this.storage.list<TemplateConfig>(["library", "templates", workspace_id])
      ) {
        if (value) {
          templates.push(value);
        }
      }
    }

    // Get global templates
    for await (
      const { value } of this.storage.list<TemplateConfig>(["library", "templates", "global"])
    ) {
      if (value) {
        templates.push(value);
      }
    }

    return templates;
  }

  /**
   * Delete a template
   */
  async deleteTemplate(id: string, workspace_id?: string): Promise<boolean> {
    if (workspace_id) {
      await this.storage.delete(["library", "templates", workspace_id, id]);
    } else {
      await this.storage.delete(["library", "templates", "global", id]);
    }

    await this.storage.set(["library", "lastUpdated"], new Date().toISOString());
    return true;
  }

  /**
   * Update index for better search performance
   * This can be called periodically to rebuild indexes
   */
  async updateIndex(): Promise<void> {
    // Clear existing indexes
    const atomic = this.storage.atomic();

    // Get all items and rebuild indexes
    const items: LibraryMetadata[] = [];
    for await (const { value } of this.storage.list<LibraryMetadata>(["library", "items"])) {
      if (value) {
        items.push(value);
      }
    }

    // Rebuild indexes
    for (const item of items) {
      atomic.set(["library", "indexes", "by_type", item.type, item.id], item.id);

      for (const tag of item.tags) {
        atomic.set(["library", "indexes", "by_tag", tag, item.id], item.id);
      }

      if (item.workspace_id) {
        atomic.set(["library", "indexes", "by_workspace", item.workspace_id, item.id], item.id);
      }

      const datePrefix = item.created_at.substring(0, 7);
      atomic.set(["library", "indexes", "by_date", datePrefix, item.id], item.id);
    }

    atomic.set(["library", "lastUpdated"], new Date().toISOString());

    const success = await atomic.commit();
    if (!success) {
      throw new Error("Failed to update library index - atomic operation failed");
    }
  }

  /**
   * Close the storage adapter
   */
  async close(): Promise<void> {
    await this.storage.close();
  }

  /**
   * Generate organized content path for a library item
   */
  private generateContentPath(id: string, type: string, format: string, createdAt: string): string {
    const extension = this.config.extensionMap[format] || "dat";
    const filename = `${id}.${extension}`;

    let path = filename;

    if (this.config.organizeByDate) {
      const date = new Date(createdAt);
      const year = date.getFullYear().toString();
      const month = (date.getMonth() + 1).toString().padStart(2, "0");
      path = join(year, month, filename);
    }

    if (this.config.organizeByType) {
      path = join(type, path);
    }

    return path;
  }

  /**
   * Get storage configuration
   */
  getConfig(): Required<LibraryStorageConfig> {
    return { ...this.config };
  }

  /**
   * Get content directory path
   */
  getContentDir(): string {
    return this.contentDir;
  }

  /**
   * Check disk usage and cleanup if needed
   */
  async getDiskUsage(): Promise<{
    totalSize: number;
    itemCount: number;
    contentDir: string;
  }> {
    let totalSize = 0;
    let itemCount = 0;

    try {
      for await (const { value } of this.storage.list<LibraryMetadata>(["library", "items"])) {
        if (value) {
          totalSize += value.size_bytes;
          itemCount++;
        }
      }
    } catch {
      // If we can't read from storage, try scanning disk
      for await (const entry of this.walkContentDirectory(this.contentDir)) {
        if (entry.isFile) {
          const stat = await Deno.stat(entry.path);
          totalSize += stat.size;
          itemCount++;
        }
      }
    }

    return {
      totalSize,
      itemCount,
      contentDir: this.contentDir,
    };
  }

  /**
   * Walk content directory recursively
   */
  private async *walkContentDirectory(
    dir: string,
  ): AsyncGenerator<{ path: string; isFile: boolean }> {
    try {
      for await (const entry of Deno.readDir(dir)) {
        const path = join(dir, entry.name);
        if (entry.isDirectory) {
          yield* this.walkContentDirectory(path);
        } else {
          yield { path, isFile: true };
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
  }

  /**
   * Get the underlying storage for advanced operations
   */
  getStorage(): KVStorage {
    return this.storage;
  }
}
