/**
 * Library-related type definitions
 */

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

export interface LibraryItem {
  id: string;
  source: "agent" | "job" | "user" | "system";
  name: string;
  description?: string;
  content_path: string;
  full_path: string;
  file_extension: string;
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

export interface TemplateConfig {
  id: string;
  name: string;
  description?: string;
  format: string;
  engine: string;
  category?: string;
  config: Record<string, unknown>;
  schema?: Record<string, unknown>;
}

export interface LibraryItemWithContent {
  item: LibraryItem;
  content?: string | Uint8Array;
}

interface GenerateFromTemplateRequest {
  templateId: string;
  data: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export interface DeleteLibraryItemResponse {
  message: string;
}
