/**
 * Memory Manager Types
 *
 * Defines types for the memory navigation tool that align with MECMF
 */

// Use the MECMF CoALAMemoryEntry interface and CoALAMemoryType enum
import type { CoALAMemoryEntry, CoALAMemoryType } from "@atlas/memory";

// Re-export for external use;
export type { CoALAMemoryType };

// Create a MemoryEntry type alias for consistency
export type MemoryEntry = CoALAMemoryEntry;

export interface VectorSearchResult extends MemoryEntry {
  similarity: number;
  matchedContent: string;
}

export interface MemoryStorage {
  loadAll(): Promise<Record<CoALAMemoryType, Record<string, MemoryEntry>>>;
  saveAll(data: Record<CoALAMemoryType, Record<string, MemoryEntry>>): Promise<void>;
  loadByType(type: CoALAMemoryType): Promise<Record<string, MemoryEntry>>;
  saveByType(type: CoALAMemoryType, data: Record<string, MemoryEntry>): Promise<void>;
}

export interface TUIState {
  currentTab: CoALAMemoryType | "vector-search";
  selectedIndex: number;
  scrollOffset: number;
  searchQuery: string;
  showHelp: boolean;
  mode:
    | "workspace-selector"
    | "list"
    | "view"
    | "edit"
    | "create"
    | "delete"
    | "search"
    | "vector-search";
  editState?: EditState;
  showOverlay: boolean;
  overlayContent?: OverlayContent;
  vectorSearchQuery?: string;
  vectorSearchResults?: VectorSearchResult[];
  workspaceSelection?: WorkspaceSelectionState;
}

interface OverlayContent {
  title: string;
  content: unknown;
  scrollOffset: number;
  maxScroll: number;
}

export interface KeyBinding {
  key: string;
  description: string;
  action: () => void;
}

export interface TabInfo {
  type: CoALAMemoryType | "vector-search";
  title: string;
  count: number;
  color: string;
}

interface EditState {
  entryId: string;
  currentField: EditableField;
  fieldValues: Record<string, unknown>;
  originalEntry: MemoryEntry;
}

enum EditableField {
  CONTENT = "content",
  TAGS = "tags",
  RELEVANCE_SCORE = "relevanceScore",
  CONFIDENCE = "confidence",
  ASSOCIATIONS = "associations",
}

// Workspace selection types
// Import proper workspace types
import type { WorkspaceEntry as CoreWorkspaceEntry, WorkspaceStatus } from "@atlas/workspace";

// Re-export the proper WorkspaceEntry type which includes status
export type WorkspaceEntry = CoreWorkspaceEntry;

// Re-export WorkspaceStatus for use in other files
export type { WorkspaceStatus };

interface WorkspaceSelectionState {
  availableWorkspaces: WorkspaceEntry[];
  selectedWorkspaceIndex: number;
  loading: boolean;
  error?: string;
}
