/**
 * Test fixtures for library MCP tools
 */

import type { LibraryItem, LibrarySearchResult, LibraryStats, TemplateConfig } from "@atlas/client";

export const mockLibraryItem: LibraryItem = {
  id: "lib-123",
  type: "report",
  name: "Test Report",
  description: "A test report for unit testing",
  metadata: {
    format: "json",
    source: "test-agent",
    session_id: "session-456",
    agent_ids: ["agent-789"],
    engine: "claude-3-sonnet",
    custom_fields: {
      test_field: "test_value",
    },
  },
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  tags: ["test", "report"],
  size_bytes: 1024,
  workspace_id: "workspace-123",
};

export const mockLibraryItems: LibraryItem[] = [
  mockLibraryItem,
  {
    id: "lib-456",
    type: "session_archive",
    name: "Session Archive",
    description: "Archived session data",
    metadata: {
      format: "json",
      source: "session-archiver",
      session_id: "session-789",
      agent_ids: ["agent-123"],
      engine: "claude-3-haiku",
    },
    created_at: "2024-01-02T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    tags: ["archive", "session"],
    size_bytes: 2048,
    workspace_id: "workspace-456",
  },
  {
    id: "lib-789",
    type: "template",
    name: "Test Template",
    description: "A test template",
    metadata: {
      format: "yaml",
      source: "template-engine",
      template_id: "template-123",
      created_by: "user-123",
    },
    created_at: "2024-01-03T00:00:00Z",
    updated_at: "2024-01-03T00:00:00Z",
    tags: ["template", "test"],
    size_bytes: 512,
  },
];

export const mockLibrarySearchResult: LibrarySearchResult = {
  items: mockLibraryItems,
  total: 3,
  query: {
    query: "test",
    limit: 50,
    offset: 0,
  },
  took_ms: 25,
};

export const mockLibraryItemWithContent = {
  item: mockLibraryItem,
  content: JSON.stringify({
    title: "Test Report",
    summary: "This is a test report",
    data: [1, 2, 3],
  }),
};

export const mockLibraryStats: LibraryStats = {
  total_items: 150,
  total_size_bytes: 1048576,
  types: {
    report: 75,
    session_archive: 50,
    template: 15,
    artifact: 10,
  },
  tags: {
    test: 25,
    report: 75,
    archive: 50,
    template: 15,
  },
  recent_activity: [
    {
      date: "2024-01-01",
      items_added: 5,
      items_modified: 2,
      size_added_bytes: 10240,
    },
    {
      date: "2024-01-02",
      items_added: 3,
      items_modified: 1,
      size_added_bytes: 5120,
    },
  ],
  storage_stats: {
    used_bytes: 1048576,
    limit_bytes: 10485760,
    percentage_used: 10,
  },
};

export const mockTemplateConfigs: TemplateConfig[] = [
  {
    id: "template-123",
    name: "Test Template",
    description: "A test template for unit testing",
    format: "yaml",
    engine: "handlebars",
    category: "test",
    config: {
      version: "1.0",
      variables: ["name", "description"],
    },
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    id: "template-456",
    name: "Report Template",
    description: "Template for generating reports",
    format: "json",
    engine: "mustache",
    category: "reports",
    config: {
      version: "2.0",
      variables: ["title", "data"],
    },
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        data: { type: "array" },
      },
      required: ["title", "data"],
    },
  },
];

export const mockErrorResponse = {
  error: "Internal server error",
  code: 500,
  details: "Database connection failed",
};

export const mockTimeoutResponse = {
  error: "Request timeout",
  code: 408,
  details: "Request took too long to process",
};

export const mockEmptyResponse = {
  items: [],
  total: 0,
  query: {
    query: "empty-result",
    limit: 50,
    offset: 0,
  },
  took_ms: 5,
};

export const mockDaemonApiResponses = {
  "/api/library": mockLibrarySearchResult,
  "/api/library/search": mockLibrarySearchResult,
  "/api/library/lib-123": mockLibraryItemWithContent,
  "/api/library/lib-123?content=true": mockLibraryItemWithContent,
  "/api/library/lib-123?content=false": mockLibraryItemWithContent,
  "/api/library/stats": mockLibraryStats,
  "/api/library/templates": mockTemplateConfigs,
  "/api/library/nonexistent": null, // For 404 testing
  "/api/library/empty": mockEmptyResponse,
};
