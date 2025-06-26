import {
  ILibraryStorage,
  LibraryIndex,
  LibraryIndexItem,
  LibraryItem,
  LibrarySearchQuery,
  LibraryStats,
} from "../types.ts";
import { exists } from "@std/fs";
import * as path from "@std/path";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";

/**
 * Local filesystem storage for library items
 */
export class LocalLibraryStorage implements ILibraryStorage {
  private libraryPath: string;
  private indexPath: string;
  private artifactsPath: string;

  constructor(libraryPath: string) {
    if (!libraryPath || typeof libraryPath !== "string") {
      throw new Error(`Invalid library path: expected string, got ${typeof libraryPath}`);
    }
    this.libraryPath = libraryPath;
    this.indexPath = path.join(libraryPath, "index.json");
    this.artifactsPath = path.join(libraryPath, "artifacts");
  }

  async store(item: LibraryItem, content: string | Uint8Array): Promise<void> {
    // Ensure library directory structure exists
    await this.ensureDirectoryStructure();

    // Create type-specific directory
    const typeDir = path.join(this.artifactsPath, item.type);
    await Deno.mkdir(typeDir, { recursive: true });

    // Generate content path with timestamp and type organization
    const timestamp = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const datePath = path.join(typeDir, timestamp);
    await Deno.mkdir(datePath, { recursive: true });

    // Write content to file
    const contentPath = path.join(
      datePath,
      `${item.id}.${this.getFileExtension(item.metadata.format)}`,
    );

    if (typeof content === "string") {
      await Deno.writeTextFile(contentPath, content);
    } else {
      await Deno.writeFile(contentPath, content);
    }

    // Update item with actual content path
    item.content_path = path.relative(this.libraryPath, contentPath);
    item.size_bytes = typeof content === "string"
      ? new TextEncoder().encode(content).length
      : content.length;

    // Update index
    await this.addToIndex(item);
  }

  async retrieve(id: string): Promise<{ item: LibraryItem; content: string | Uint8Array } | null> {
    const index = await this.loadIndex();
    const indexItem = index.items.find((item) => item.id === id);

    if (!indexItem) {
      return null;
    }

    // Load full metadata
    const metadataPath = path.join(this.libraryPath, "metadata", `${id}.json`);
    let item: LibraryItem;

    try {
      const metadataContent = await Deno.readTextFile(metadataPath);
      item = JSON.parse(metadataContent);
    } catch {
      // Fallback to index data if metadata file missing
      item = this.indexItemToLibraryItem(indexItem);
    }

    // Load content
    const contentPath = path.join(this.libraryPath, item.content_path);

    try {
      if (item.metadata.format === "binary") {
        const content = await Deno.readFile(contentPath);
        return { item, content };
      } else {
        const content = await Deno.readTextFile(contentPath);
        return { item, content };
      }
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.retrieve(id);
    if (!result) {
      return false;
    }

    try {
      // Delete content file
      const contentPath = path.join(this.libraryPath, result.item.content_path);
      await Deno.remove(contentPath);

      // Delete metadata file
      const metadataPath = path.join(this.libraryPath, "metadata", `${id}.json`);
      try {
        await Deno.remove(metadataPath);
      } catch {
        // Metadata file may not exist
      }

      // Remove from index
      await this.removeFromIndex(id);

      return true;
    } catch {
      return false;
    }
  }

  async list(query: LibrarySearchQuery): Promise<LibraryItem[]> {
    const index = await this.loadIndex();
    let items = index.items;

    // Apply filters
    if (query.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      items = items.filter((item) => types.includes(item.type));
    }

    if (query.tags && query.tags.length > 0) {
      items = items.filter((item) => query.tags!.some((tag) => item.tags.includes(tag)));
    }

    if (query.since) {
      const sinceDate = new Date(query.since);
      items = items.filter((item) => new Date(item.created_at) >= sinceDate);
    }

    if (query.until) {
      const untilDate = new Date(query.until);
      items = items.filter((item) => new Date(item.created_at) <= untilDate);
    }

    // Text search in name and metadata
    if (query.query) {
      const searchTerm = query.query.toLowerCase();
      items = items.filter((item) =>
        item.name.toLowerCase().includes(searchTerm) ||
        item.tags.some((tag) => tag.toLowerCase().includes(searchTerm))
      );
    }

    // Sort by creation date (newest first)
    items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    // Apply pagination
    const offset = query.offset || 0;
    const limit = query.limit || 50;
    items = items.slice(offset, offset + limit);

    // Convert index items to full library items
    return Promise.all(items.map(async (indexItem) => {
      const full = await this.retrieve(indexItem.id);
      return full ? full.item : this.indexItemToLibraryItem(indexItem);
    }));
  }

  async updateIndex(): Promise<void> {
    // Rebuild index by scanning artifacts directory
    const index = await this.loadIndex();
    const scannedItems: LibraryIndexItem[] = [];

    try {
      for await (const dirEntry of Deno.readDir(this.artifactsPath)) {
        if (dirEntry.isDirectory) {
          const typeDir = path.join(this.artifactsPath, dirEntry.name);
          await this.scanTypeDirectory(typeDir, dirEntry.name, scannedItems);
        }
      }
    } catch {
      // Artifacts directory may not exist yet
    }

    // Update index with scanned items
    index.items = scannedItems;
    index.updated = new Date().toISOString();
    index.stats = await this.calculateStats(scannedItems);

    await this.saveIndex(index);
  }

  async getStats(): Promise<LibraryStats> {
    const index = await this.loadIndex();
    return index.stats;
  }

  private async ensureDirectoryStructure(): Promise<void> {
    await Deno.mkdir(this.libraryPath, { recursive: true });
    await Deno.mkdir(this.artifactsPath, { recursive: true });
    await Deno.mkdir(path.join(this.libraryPath, "metadata"), { recursive: true });
    await Deno.mkdir(path.join(this.libraryPath, "cache"), { recursive: true });
  }

  private async loadIndex(): Promise<LibraryIndex> {
    try {
      const content = await Deno.readTextFile(this.indexPath);
      return JSON.parse(content);
    } catch {
      // Create default index if file doesn't exist
      return {
        version: "1.0",
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        items: [],
        tags: {},
        stats: {
          total_items: 0,
          total_size_bytes: 0,
          types: {},
          recent_activity: [],
        },
      };
    }
  }

  private async saveIndex(index: LibraryIndex): Promise<void> {
    await this.ensureDirectoryStructure();
    await Deno.writeTextFile(this.indexPath, JSON.stringify(index, null, 2));
  }

  private async addToIndex(item: LibraryItem): Promise<void> {
    const index = await this.loadIndex();

    // Remove existing item if it exists
    index.items = index.items.filter((existing) => existing.id !== item.id);

    // Add new item
    const indexItem: LibraryIndexItem = {
      id: item.id,
      type: item.type,
      name: item.name,
      path: item.content_path,
      created_at: item.created_at,
      tags: item.tags,
      size_bytes: item.size_bytes,
      metadata_hash: await this.generateMetadataHash(item),
    };

    index.items.push(indexItem);

    // Update tag counts
    for (const tag of item.tags) {
      index.tags[tag] = (index.tags[tag] || 0) + 1;
    }

    // Update stats
    index.stats = await this.calculateStats(index.items);
    index.updated = new Date().toISOString();

    // Save updated index
    await this.saveIndex(index);

    // Save full metadata separately for complex items
    const metadataPath = path.join(this.libraryPath, "metadata", `${item.id}.json`);
    await Deno.writeTextFile(metadataPath, JSON.stringify(item, null, 2));
  }

  private async removeFromIndex(id: string): Promise<void> {
    const index = await this.loadIndex();
    const item = index.items.find((item) => item.id === id);

    if (!item) {
      return;
    }

    // Remove from items
    index.items = index.items.filter((existing) => existing.id !== id);

    // Update tag counts
    for (const tag of item.tags) {
      if (index.tags[tag]) {
        index.tags[tag]--;
        if (index.tags[tag] === 0) {
          delete index.tags[tag];
        }
      }
    }

    // Update stats
    index.stats = await this.calculateStats(index.items);
    index.updated = new Date().toISOString();

    await this.saveIndex(index);
  }

  private async scanTypeDirectory(
    typeDir: string,
    type: string,
    scannedItems: LibraryIndexItem[],
  ): Promise<void> {
    try {
      for await (const dateEntry of Deno.readDir(typeDir)) {
        if (dateEntry.isDirectory) {
          const datePath = path.join(typeDir, dateEntry.name);
          for await (const fileEntry of Deno.readDir(datePath)) {
            if (fileEntry.isFile) {
              const filePath = path.join(datePath, fileEntry.name);
              const stat = await Deno.stat(filePath);
              const id = path.parse(fileEntry.name).name;

              scannedItems.push({
                id,
                type,
                name: fileEntry.name,
                path: path.relative(this.libraryPath, filePath),
                created_at: stat.birthtime?.toISOString() || new Date().toISOString(),
                tags: [],
                size_bytes: stat.size,
                metadata_hash: "",
              });
            }
          }
        }
      }
    } catch {
      // Directory may not exist or be accessible
    }
  }

  private async calculateStats(items: LibraryIndexItem[]): Promise<LibraryStats> {
    const stats: LibraryStats = {
      total_items: items.length,
      total_size_bytes: items.reduce((sum, item) => sum + item.size_bytes, 0),
      types: {},
      recent_activity: [],
    };

    // Count by type
    for (const item of items) {
      stats.types[item.type] = (stats.types[item.type] || 0) + 1;
    }

    // Calculate recent activity (last 7 days)
    const now = new Date();
    for (let i = 0; i < 7; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split("T")[0];

      const dayItems = items.filter((item) => item.created_at.startsWith(dateStr));

      if (dayItems.length > 0) {
        stats.recent_activity.push({
          date: dateStr,
          items_added: dayItems.length,
          items_modified: 0, // TODO: Track modifications
        });
      }
    }

    return stats;
  }

  private async generateMetadataHash(item: LibraryItem): Promise<string> {
    const hashData = JSON.stringify({
      type: item.type,
      metadata: item.metadata,
      tags: item.tags.sort(),
    });

    const encoder = new TextEncoder();
    const data = encoder.encode(hashData);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").substring(0, 16);
  }

  private indexItemToLibraryItem(indexItem: LibraryIndexItem): LibraryItem {
    return {
      id: indexItem.id,
      type: indexItem.type as any,
      name: indexItem.name,
      content_path: indexItem.path,
      metadata: {
        format: this.getFormatFromPath(indexItem.path),
        source: "unknown" as any,
      },
      created_at: indexItem.created_at,
      updated_at: indexItem.created_at,
      tags: indexItem.tags,
      size_bytes: indexItem.size_bytes,
    };
  }

  private getFileExtension(format: string): string {
    switch (format) {
      case "markdown":
        return "md";
      case "json":
        return "json";
      case "html":
        return "html";
      case "text":
        return "txt";
      default:
        return "bin";
    }
  }

  private getFormatFromPath(filePath: string): "markdown" | "json" | "html" | "text" | "binary" {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case ".md":
        return "markdown";
      case ".json":
        return "json";
      case ".html":
      case ".htm":
        return "html";
      case ".txt":
        return "text";
      default:
        return "binary";
    }
  }
}
