/**
 * Library-related type definitions
 */

export interface LibrarySearchQuery {
  query?: string;
  type?: string | string[];
  tags?: string[];
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface LibraryItem {
  id: string;
  type: string;
  name: string;
  description?: string;
  metadata: {
    format: string;
    source: string;
    session_id?: string;
    agent_ids?: string[];
    engine?: string;
    template_id?: string;
    created_by?: string;
    custom_fields?: Record<string, unknown>;
  };
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
  types: Record<string, number>;
  tags?: Record<string, number>;
  recent_activity: Array<{
    date: string;
    items_added: number;
    items_modified: number;
    size_added_bytes?: number;
  }>;
  storage_stats?: {
    used_bytes: number;
    limit_bytes?: number;
    percentage_used?: number;
  };
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

export interface GenerateFromTemplateRequest {
  templateId: string;
  data: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export interface DeleteLibraryItemResponse {
  message: string;
}
