// Core types for the Atlas Library system

// Legacy type - use source field instead
// export type LibraryItemType = "report" | "session_archive" | "template" | "artifact" | "user_upload";

export interface LibraryItem {
  id: string;
  source: "agent" | "job" | "user" | "system";
  name: string;
  description?: string;
  content_path: string;
  full_path: string; // Full absolute path to content file
  file_extension: string; // File extension (.md, .pdf, .jpg, etc.)
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

export interface StoreItemInput {
  id: string;
  source: "agent" | "job" | "user" | "system";
  name: string;
  description?: string;
  content: string | Uint8Array;
  mime_type: string;
  filename?: string;
  session_id?: string;
  agent_ids?: string[];
  template_id?: string;
  generated_by?: string;
  custom_fields?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  tags: string[];
  workspace_id?: string;
}

export interface TemplateConfig {
  id: string;
  name: string;
  description?: string;
  format: "markdown" | "json" | "html" | "text";
  engine: string;
  config: Record<string, unknown>;
  schema?: Record<string, unknown>;
  metadata?: TemplateMetadata;
}

interface TemplateMetadata {
  version?: string;
  author?: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  usage_count?: number;
}

export interface LibrarySearchQuery {
  query?: string;
  source?: string | string[];
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

export interface LibraryStats {
  total_items: number;
  total_size_bytes: number;
  sources: Record<string, number>;
  recent_activity: Array<{ date: string; items_added: number; items_modified: number }>;
}
