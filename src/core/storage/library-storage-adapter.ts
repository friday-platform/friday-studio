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

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import type {
  LibraryItem,
  LibrarySearchQuery,
  LibrarySearchResult,
  LibraryStats,
  StoreItemInput,
  TemplateConfig,
} from "@atlas/core/library";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { typeByExtension } from "@std/media-types";
import { throwWithCause } from "../../../packages/core/src/utils/error-helpers.ts";
import type { KVStorage } from "./kv-storage.ts";

/**
 * Extension overrides for incorrect @std/media-types mappings
 * @std/media-types maps .ts to video/mp2t (MPEG transport stream), but we want text/plain for code files
 */
const EXTENSION_OVERRIDES: Record<string, string> = {
  ts: "text/plain", // TypeScript (not video/mp2t)
  tsx: "text/plain", // TypeScript JSX
  jsx: "text/plain", // JavaScript JSX
};

/**
 * Library storage configuration
 */
export interface LibraryStorageConfig {
  /** Base directory for content storage. Defaults to ~/.atlas/library */
  contentDir?: string;
  /** Whether to organize content by source subdirectories */
  organizeBySource?: boolean;
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
  if (process.platform === "win32") {
    // Windows: Use LOCALAPPDATA or APPDATA
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      return join(localAppData, "Atlas", "library");
    }
    const appData = process.env.APPDATA;
    if (appData) {
      return join(appData, "Atlas", "library");
    }
  } else if (process.platform === "darwin") {
    // macOS: Use ~/Library/Application Support
    const homeDir = process.env.HOME;
    if (homeDir) {
      return join(homeDir, "Library", "Application Support", "Atlas", "library");
    }
  } else {
    // Linux/Unix: Use XDG_DATA_HOME or ~/.local/share
    const xdgDataHome = process.env.XDG_DATA_HOME;
    if (xdgDataHome) {
      return join(xdgDataHome, "atlas", "library");
    }
    const homeDir = process.env.HOME;
    if (homeDir) {
      return join(homeDir, ".local", "share", "atlas", "library");
    }
  }

  // Fallback to current directory
  return join(process.cwd(), ".atlas", "library");
}

/**
 * Library item for KV storage (metadata only)
 */
interface LibraryMetadata {
  id: string;
  type: "report" | "session_archive" | "template" | "artifact" | "user_upload";
  source: "agent" | "job" | "user" | "system";
  name: string;
  description?: string;
  content_path: string;
  mime_type: string;
  session_id?: string;
  agent_ids?: string[];
  template_id?: string;
  generated_by?: string;
  custom_fields?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  tags: string[];
  size_bytes: number;
  workspace_id?: string;
}

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

  constructor(
    private storage: KVStorage,
    config: LibraryStorageConfig = {},
  ) {
    // Apply defaults to config
    this.config = {
      contentDir: config.contentDir || getDefaultLibraryDir(),
      organizeBySource: config.organizeBySource ?? true,
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
   * Get file extension from filename
   */
  private getFileExtension(filename: string): string {
    const lastDot = filename.lastIndexOf(".");
    return lastDot > 0 ? filename.substring(lastDot + 1).toLowerCase() : "";
  }

  /**
   * Get file extension for storage
   * Simplified: extract from filename if available, otherwise use "dat"
   */
  private getExtensionForMimeType(filename?: string): string {
    if (filename) {
      const ext = this.getFileExtension(filename);
      if (ext) {
        return ext;
      }
    }

    return "dat";
  }

  /**
   * Initialize the library storage
   * Sets up initial metadata, indexes, and content directories
   */
  async initialize(): Promise<void> {
    await this.storage.initialize();

    // Ensure content directory exists
    await mkdir(this.contentDir, { recursive: true });

    // Create organized subdirectories if configured
    if (this.config.organizeBySource) {
      const sourceNames = ["agent", "job", "user", "system"];
      for (const sourceName of sourceNames) {
        await mkdir(join(this.contentDir, sourceName), { recursive: true });
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
   * Returns both the full path and the enhanced item structure
   */
  async storeItem(item: StoreItemInput): Promise<{ path: string; item: LibraryItem }> {
    // Validate item structure (basic validation)
    if (!item.id || !item.type || !item.source || !item.name || !item.content) {
      throwWithCause(
        "Cannot store library item: Required fields are missing (id, type, source, name, or content).",
        { type: "unknown", code: "MISSING_REQUIRED_FIELDS_FOR_LIBRARY_ITEM" },
      );
    }

    // Detect MIME type with priority:
    // 1. Provided mime_type
    // 2. Extension override (for incorrect standard library mappings)
    // 3. Filename extension via @std/media-types
    // 4. Content type (binary vs text)
    let mimeType: string;
    if (item.mime_type && item.mime_type.trim() !== "") {
      mimeType = item.mime_type.trim();
    } else if (item.filename) {
      const ext = this.getFileExtension(item.filename);
      const override = ext ? EXTENSION_OVERRIDES[ext] : undefined;
      const detected = ext && !override ? typeByExtension(ext) : undefined;
      mimeType =
        override ??
        detected ??
        (item.content instanceof Uint8Array ? "application/octet-stream" : "text/plain");
    } else {
      mimeType = item.content instanceof Uint8Array ? "application/octet-stream" : "text/plain";
    }

    // Calculate content size
    const contentSize =
      typeof item.content === "string"
        ? new TextEncoder().encode(item.content).length
        : item.content.length;

    // Generate content path using file extension from filename
    const contentPath = this.generateContentPath(
      item.id,
      item.source,
      item.created_at,
      item.filename,
    );
    const fullContentPath = join(this.contentDir, contentPath);

    // Ensure content directory exists
    await mkdir(dirname(fullContentPath), { recursive: true });

    // Write content to disk
    await writeFile(fullContentPath, item.content);

    // Create metadata record for KV storage
    const metadata: LibraryMetadata = {
      id: item.id,
      type: item.type,
      source: item.source,
      name: item.name,
      description: item.description,
      content_path: contentPath,
      mime_type: mimeType,
      session_id: item.session_id,
      agent_ids: item.agent_ids,
      template_id: item.template_id,
      generated_by: item.generated_by,
      custom_fields: item.custom_fields,
      created_at: item.created_at,
      updated_at: item.updated_at,
      tags: item.tags,
      size_bytes: contentSize,
      workspace_id: item.workspace_id,
    };

    const atomic = this.storage.atomic();

    // Store metadata only in KV
    atomic.set(["library", "items", metadata.id], metadata);

    // Create tag index for search filtering
    for (const tag of metadata.tags) {
      atomic.set(["library", "indexes", "by_tag", tag, metadata.id], metadata.id);
    }

    // Update metadata
    atomic.set(["library", "lastUpdated"], new Date().toISOString());

    const success = await atomic.commit();
    if (!success) {
      // Clean up content file if KV operation failed
      try {
        await rm(fullContentPath);
      } catch {
        // Ignore cleanup errors
      }
      throwWithCause(
        "Failed to store library item. The storage operation could not be completed atomically.",
        { type: "unknown", code: "FAILED_TO_STORE_LIBRARY_ITEM_ATOMIC_OPERATION_FAILED" },
      );
    }

    // Return both path and enhanced item structure
    const enhancedItem = this.enhanceItemWithPaths(metadata);
    return { path: fullContentPath, item: enhancedItem };
  }

  /**
   * Retrieve a library item by ID (hybrid storage)
   */
  async getItem(id: string): Promise<{ item: LibraryItem; content?: string | Uint8Array } | null> {
    const metadata = await this.storage.get<LibraryMetadata>(["library", "items", id]);
    if (!metadata) {
      return null;
    }

    // Convert metadata to LibraryItem format with enhanced info
    const item: LibraryItem = this.enhanceItemWithPaths(metadata);

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
      // Use MIME type to determine if content is binary
      const mimeType = metadata.mime_type || "text/plain";
      const isText =
        mimeType.startsWith("text/") ||
        mimeType === "application/json" ||
        mimeType === "application/xml" ||
        mimeType === "application/yaml";

      if (isText) {
        content = await readFile(fullContentPath, "utf-8");
      } else {
        content = await readFile(fullContentPath);
      }
    } catch (error) {
      throwWithCause(
        `Failed to read library item '${id}'. The content file may be missing or inaccessible.`,
        error instanceof Error ? error : new Error(stringifyError(error)),
      );
    }

    // Convert metadata to LibraryItem format with enhanced info
    const item: LibraryItem = this.enhanceItemWithPaths(metadata);

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
      await rm(fullContentPath);
    } catch (error) {
      // Log warning but continue with metadata deletion
      logger.warn(`Failed to delete content file ${fullContentPath}: ${stringifyError(error)}`);
    }

    const atomic = this.storage.atomic();

    // Delete metadata
    atomic.delete(["library", "items", id]);

    // Delete tag indexes
    for (const tag of metadata.tags) {
      atomic.delete(["library", "indexes", "by_tag", tag, id]);
    }

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

    // Filter by tags if specified
    if (query.tags && query.tags.length > 0) {
      const tagIds = new Set<string>();

      for (const tag of query.tags) {
        for await (const { key } of this.storage.list(["library", "indexes", "by_tag", tag])) {
          if (key.length === 5) {
            // ['library', 'indexes', 'by_tag', tag, id]
            const itemId = key[4];
            if (typeof itemId === "string") {
              tagIds.add(itemId);
            }
          }
        }
      }

      if (candidateIds) {
        // Intersection of source and tag filters
        candidateIds = new Set([...candidateIds].filter((id) => tagIds.has(id)));
      } else {
        candidateIds = tagIds;
      }
    }

    // If no specific filters, get all items
    if (!candidateIds) {
      for await (const { value } of this.storage.list<LibraryMetadata>(["library", "items"])) {
        if (value) {
          // Convert metadata to LibraryItem format with enhanced info
          const item: LibraryItem = this.enhanceItemWithPaths(value);
          items.push(item);
        }
      }
    } else {
      // Fetch items by candidate IDs
      for (const id of candidateIds) {
        const metadata = await this.storage.get<LibraryMetadata>(["library", "items", id]);
        if (metadata) {
          // Convert metadata to LibraryItem format with enhanced info
          const item: LibraryItem = this.enhanceItemWithPaths(metadata);
          items.push(item);
        }
      }
    }

    // Apply additional filters
    let filteredItems = items;

    // Type filter
    if (query.type) {
      const allowedTypes = Array.isArray(query.type) ? query.type : [query.type];
      const typeSet = new Set(allowedTypes);
      filteredItems = filteredItems.filter((item) => typeSet.has(item.type));
    }

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
      filteredItems = filteredItems.filter(
        (item) =>
          item.name.toLowerCase().includes(searchTerm) ||
          item.description?.toLowerCase().includes(searchTerm),
      );
    }

    // Sort by created_at (newest first)
    filteredItems.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
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
  async listItems(
    options: { tags?: string[]; workspace_id?: string; since?: string; limit?: number } = {},
  ): Promise<LibraryItem[]> {
    const query: LibrarySearchQuery = {
      tags: options.tags,
      // Note: workspace filtering not supported with current LibrarySearchQuery interface
      since: options.since,
      limit: options.limit || 50,
      offset: 0,
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
      throwWithCause(
        "Failed to store template. The storage operation could not be completed atomically.",
        { type: "unknown", code: "FAILED_TO_STORE_TEMPLATE_ATOMIC_OPERATION_FAILED" },
      );
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
      for await (const { value } of this.storage.list<TemplateConfig>([
        "library",
        "templates",
        workspace_id,
      ])) {
        if (value) {
          templates.push(value);
        }
      }
    }

    // Get global templates
    for await (const { value } of this.storage.list<TemplateConfig>([
      "library",
      "templates",
      "global",
    ])) {
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

    // Rebuild tag indexes
    for (const item of items) {
      for (const tag of item.tags) {
        atomic.set(["library", "indexes", "by_tag", tag, item.id], item.id);
      }
    }

    atomic.set(["library", "lastUpdated"], new Date().toISOString());

    const success = await atomic.commit();
    if (!success) {
      throwWithCause(
        "Failed to update library index. The storage operation could not be completed atomically.",
        { type: "unknown", code: "FAILED_TO_UPDATE_LIBRARY_INDEX_ATOMIC_OPERATION_FAILED" },
      );
    }
  }

  /**
   * Close the storage adapter
   */
  async close(): Promise<void> {
    await this.storage.close();
  }

  /**
   * Enhance LibraryMetadata with computed path and extension information
   * Converts internal flat metadata structure to nested LibraryItem structure
   */
  private enhanceItemWithPaths(metadata: LibraryMetadata): LibraryItem {
    // Extract file extension from content path
    const lastDot = metadata.content_path.lastIndexOf(".");
    const fileExtension = lastDot > 0 ? metadata.content_path.substring(lastDot) : ".dat";

    // Generate full absolute path
    const fullPath = join(this.contentDir, metadata.content_path);

    return {
      id: metadata.id,
      type: metadata.type,
      name: metadata.name,
      description: metadata.description,
      content_path: metadata.content_path,
      mime_type: metadata.mime_type,
      metadata: {
        source: metadata.source,
        session_id: metadata.session_id,
        agent_ids: metadata.agent_ids,
        template_id: metadata.template_id,
        generated_by: metadata.generated_by,
        custom_fields: metadata.custom_fields,
      },
      created_at: metadata.created_at,
      updated_at: metadata.updated_at,
      tags: metadata.tags,
      size_bytes: metadata.size_bytes,
      workspace_id: metadata.workspace_id,
      full_path: fullPath,
      file_extension: fileExtension,
    };
  }

  /**
   * Generate organized content path for a library item
   */
  private generateContentPath(
    id: string,
    source: string,
    createdAt: string,
    filename?: string,
  ): string {
    const extension = this.getExtensionForMimeType(filename);
    const filepath = `${id}.${extension}`;

    let path = filepath;

    if (this.config.organizeByDate) {
      const date = new Date(createdAt);
      const year = date.getFullYear().toString();
      const month = (date.getMonth() + 1).toString().padStart(2, "0");
      path = join(year, month, filepath);
    }

    if (this.config.organizeBySource) {
      path = join(source, path);
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
  async getDiskUsage(): Promise<{ totalSize: number; itemCount: number; contentDir: string }> {
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
          const stats = await stat(entry.path);
          totalSize += stats.size;
          itemCount++;
        }
      }
    }

    return { totalSize, itemCount, contentDir: this.contentDir };
  }

  /**
   * Walk content directory recursively
   */
  private async *walkContentDirectory(
    dir: string,
  ): AsyncGenerator<{ path: string; isFile: boolean }> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
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
