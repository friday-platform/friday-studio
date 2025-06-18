// Core types for the Atlas Library system

export interface LibraryItem {
  id: string;
  type: "report" | "session_archive" | "template" | "artifact" | "user_upload";
  name: string;
  description?: string;
  content_path: string;
  metadata: LibraryItemMetadata;
  created_at: string;
  updated_at: string;
  tags: string[];
  size_bytes: number;
  workspace_id?: string;
}

export interface LibraryItemMetadata {
  format: "markdown" | "json" | "html" | "text" | "binary";
  source: "agent" | "job" | "user" | "system";
  session_id?: string;
  agent_ids?: string[];
  template_id?: string;
  generated_by?: string;
  custom_fields?: Record<string, any>;
}

export interface TemplateConfig {
  id: string;
  name: string;
  description?: string;
  format: "markdown" | "json" | "html" | "text";
  engine: string;
  config: Record<string, any>;
  schema?: Record<string, any>;
  metadata?: TemplateMetadata;
}

export interface TemplateMetadata {
  version?: string;
  author?: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  usage_count?: number;
}

export interface LibrarySearchQuery {
  query?: string;
  type?: string | string[];
  tags?: string[];
  workspace?: boolean;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface LibrarySearchResult {
  items: LibraryItem[];
  total: number;
  query: LibrarySearchQuery;
  took_ms: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

export interface LibraryStorageConfig {
  platform_path: string;
  workspace_relative: string;
  encryption?: boolean;
  compression?: boolean;
  max_file_size_mb?: number;
  retention_days?: number;
}

export interface LibraryIndex {
  version: string;
  workspace_id?: string;
  created: string;
  updated: string;
  items: LibraryIndexItem[];
  tags: Record<string, number>;
  stats: LibraryStats;
}

export interface LibraryIndexItem {
  id: string;
  type: string;
  name: string;
  path: string;
  created_at: string;
  tags: string[];
  size_bytes: number;
  metadata_hash: string;
}

export interface LibraryStats {
  total_items: number;
  total_size_bytes: number;
  types: Record<string, number>;
  recent_activity: Array<{
    date: string;
    items_added: number;
    items_modified: number;
  }>;
}

// Template engine interfaces
export interface ITemplateEngine {
  readonly type: string;
  canHandle(template: TemplateConfig): boolean;
  apply(template: TemplateConfig, data: any): Promise<string>;
  validate(template: TemplateConfig): ValidationResult;
}

export interface TemplateEngineRegistry {
  register(engine: ITemplateEngine): void;
  getEngine(type: string): ITemplateEngine | undefined;
  findEngine(template: TemplateConfig): ITemplateEngine | undefined;
  listEngines(): ITemplateEngine[];
}

// Storage interfaces
export interface ILibraryStorage {
  store(item: LibraryItem, content: string | Uint8Array): Promise<void>;
  retrieve(id: string): Promise<{ item: LibraryItem; content: string | Uint8Array } | null>;
  delete(id: string): Promise<boolean>;
  list(query: LibrarySearchQuery): Promise<LibraryItem[]>;
  updateIndex(): Promise<void>;
  getStats(): Promise<LibraryStats>;
}
