import {
  ILibraryStorage,
  LibraryItem,
  LibrarySearchQuery,
  LibrarySearchResult,
  LibraryStats,
  LibraryStorageConfig,
  TemplateConfig,
} from "./types.ts";
import { createDefaultRegistry, TemplateEngineRegistry } from "./template-engine-registry.ts";
import { LocalLibraryStorage } from "./storage/local-storage.ts";
import * as path from "@std/path";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";

/**
 * Main Atlas Library class providing template processing and artifact storage
 */
export class AtlasLibrary {
  private storage: ILibraryStorage;
  private templateRegistry!: TemplateEngineRegistry;
  private templates: Map<string, TemplateConfig> = new Map();
  private workspacePath?: string;
  private workspaceId?: string;

  constructor(
    private config: LibraryStorageConfig,
    workspacePath?: string,
    workspaceId?: string,
  ) {
    this.workspacePath = workspacePath;
    this.workspaceId = workspaceId;

    // Initialize storage
    const libraryPath = workspacePath
      ? path.join(workspacePath, config.workspace_relative)
      : this.expandPath(config.platform_path);

    this.storage = new LocalLibraryStorage(libraryPath);
  }

  /**
   * Initialize the library with template engines and configurations
   */
  async initialize(): Promise<void> {
    this.templateRegistry = await createDefaultRegistry();
    await this.loadTemplates();
  }

  /**
   * Store an artifact in the library
   */
  async store(artifact: {
    type: LibraryItem["type"];
    name: string;
    content: string | Uint8Array;
    format: "markdown" | "json" | "html" | "text" | "binary";
    source: "agent" | "job" | "user" | "system";
    tags?: string[];
    description?: string;
    metadata?: Record<string, any>;
    session_id?: string;
    agent_ids?: string[];
  }): Promise<string> {
    const id = await this.generateId();
    const now = new Date().toISOString();

    const item: LibraryItem = {
      id,
      type: artifact.type,
      name: artifact.name,
      description: artifact.description,
      content_path: "", // Will be set by storage
      metadata: {
        format: artifact.format,
        source: artifact.source,
        session_id: artifact.session_id,
        agent_ids: artifact.agent_ids,
        custom_fields: artifact.metadata,
      },
      created_at: now,
      updated_at: now,
      tags: artifact.tags || [],
      size_bytes: 0, // Will be calculated by storage
      workspace_id: this.workspaceId,
    };

    await this.storage.store(item, artifact.content);
    return id;
  }

  /**
   * Retrieve an artifact from the library
   */
  async get(id: string): Promise<{ item: LibraryItem; content: string | Uint8Array } | null> {
    return await this.storage.retrieve(id);
  }

  /**
   * Search the library
   */
  async search(query: LibrarySearchQuery): Promise<LibrarySearchResult> {
    const startTime = Date.now();
    const items = await this.storage.list(query);
    const took_ms = Date.now() - startTime;

    return {
      items,
      total: items.length, // TODO: Implement proper count without loading all items
      query,
      took_ms,
    };
  }

  /**
   * List library contents with optional filters
   */
  async list(options: {
    type?: string | string[];
    tags?: string[];
    since?: string;
    limit?: number;
    workspace?: boolean;
  } = {}): Promise<LibraryItem[]> {
    const query: LibrarySearchQuery = {
      type: options.type,
      tags: options.tags,
      since: options.since,
      limit: options.limit || 50,
      workspace: options.workspace,
    };

    const result = await this.search(query);
    return result.items;
  }

  /**
   * Delete an artifact from the library
   */
  async delete(id: string): Promise<boolean> {
    return await this.storage.delete(id);
  }

  /**
   * Get library statistics
   */
  async getStats(): Promise<LibraryStats> {
    return await this.storage.getStats();
  }

  /**
   * Apply a template to generate content
   */
  async applyTemplate(templateId: string, data: any): Promise<string> {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    const engine = this.templateRegistry.findEngine(template);
    if (!engine) {
      throw new Error(
        `No template engine found for template: ${templateId} (engine: ${template.engine})`,
      );
    }

    return await engine.apply(template, data);
  }

  /**
   * Generate a report using a template and store it in the library
   */
  async generateReport(
    templateId: string,
    data: any,
    options: {
      store?: boolean;
      tags?: string[];
      name?: string;
      description?: string;
      session_id?: string;
      agent_ids?: string[];
    } = {},
  ): Promise<{ content: string; id?: string }> {
    const content = await this.applyTemplate(templateId, data);

    if (options.store) {
      const template = this.templates.get(templateId);
      const id = await this.store({
        type: "report",
        name: options.name || `${templateId}-report`,
        content,
        format: template?.format as any || "markdown",
        source: "job",
        tags: options.tags || [templateId, "generated"],
        description: options.description || `Generated report using template ${templateId}`,
        session_id: options.session_id,
        agent_ids: options.agent_ids,
        metadata: {
          template_id: templateId,
          generated_at: new Date().toISOString(),
        },
      });

      return { content, id };
    }

    return { content };
  }

  /**
   * Archive a session's data and artifacts
   */
  async archiveSession(sessionData: {
    session_id: string;
    workspace_name: string;
    start_time: string;
    end_time: string;
    agents_used: Array<{ id: string; type: string; purpose: string }>;
    artifacts: any[];
    outcomes: any[];
    metadata: Record<string, any>;
  }): Promise<string> {
    const archiveContent = {
      session: sessionData,
      archived_at: new Date().toISOString(),
      library_version: "1.0",
    };

    return await this.store({
      type: "session_archive",
      name: `session-${sessionData.session_id}`,
      content: JSON.stringify(archiveContent, null, 2),
      format: "json",
      source: "system",
      tags: ["session", "archive", sessionData.workspace_name],
      description: `Session archive for ${sessionData.session_id}`,
      session_id: sessionData.session_id,
      agent_ids: sessionData.agents_used.map((a) => a.id),
      metadata: sessionData.metadata,
    });
  }

  /**
   * Load and register templates from configuration
   */
  async loadTemplates(): Promise<void> {
    // This would be called by the config loader to register templates
    // For now, templates are loaded externally and registered via registerTemplate
  }

  /**
   * Register a template
   */
  registerTemplate(template: TemplateConfig): void {
    this.templates.set(template.id, template);
  }

  /**
   * Get available templates
   */
  getTemplates(filter: { workspace?: boolean; platform?: boolean } = {}): TemplateConfig[] {
    const templates = Array.from(this.templates.values());

    // TODO: Implement workspace vs platform filtering based on template metadata
    return templates;
  }

  /**
   * Register a template engine
   */
  registerTemplateEngine(engine: any): void {
    this.templateRegistry.register(engine);
  }

  /**
   * Get available template engine types
   */
  getAvailableEngines(): string[] {
    return this.templateRegistry.getAvailableEngineTypes();
  }

  /**
   * Update library index
   */
  async updateIndex(): Promise<void> {
    await this.storage.updateIndex();
  }

  private async generateId(): Promise<string> {
    const timestamp = Date.now().toString();
    const random = crypto.getRandomValues(new Uint8Array(8));
    const randomHex = Array.from(random, (b: number) => b.toString(16).padStart(2, "0")).join("");
    return `${timestamp}-${randomHex}`;
  }

  private expandPath(path: string): string {
    if (path.startsWith("~")) {
      return path.replace("~", Deno.env.get("HOME") || "/tmp");
    }
    return path;
  }
}
