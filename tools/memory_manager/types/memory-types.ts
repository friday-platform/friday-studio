/**
 * Memory Manager Types
 *
 * Defines types for the memory navigation tool that align with MECMF
 */

// Use the MECMF MemoryType enum
export { MemoryType } from "@atlas/memory";

// Local MemoryType for backward compatibility
export enum LocalMemoryType {
  WORKING = "working",
  EPISODIC = "episodic",
  SEMANTIC = "semantic",
  PROCEDURAL = "procedural",
}

// Use the MECMF CoALAMemoryEntry interface and CoALAMemoryType enum
export type { CoALAMemoryEntry as MemoryEntry, CoALAMemoryManager } from "@atlas/memory";
export { CoALAMemoryType } from "@atlas/memory";

export interface VectorSearchResult extends MemoryEntry {
  similarity: number;
  matchedContent: string;
}

export interface MemoryOperations {
  // CRUD operations
  create(
    type: CoALAMemoryType,
    key: string,
    content: unknown,
    metadata?: Partial<MemoryEntry>,
  ): Promise<void>;
  read(type: CoALAMemoryType, key: string): Promise<MemoryEntry | null>;
  update(
    type: CoALAMemoryType,
    key: string,
    updates: Partial<MemoryEntry>,
  ): Promise<void>;
  delete(type: CoALAMemoryType, key: string): Promise<void>;

  // List and search
  list(type: CoALAMemoryType): Promise<MemoryEntry[]>;
  search(type: CoALAMemoryType, query: string): Promise<MemoryEntry[]>;

  // Vector search operations
  vectorSearch(query: string): Promise<VectorSearchResult[]>;

  // Storage operations
  save(): Promise<void>;
  reload(): Promise<void>;
}

export interface MemoryStorage {
  loadAll(): Promise<Record<CoALAMemoryType, Record<string, MemoryEntry>>>;
  saveAll(data: Record<CoALAMemoryType, Record<string, MemoryEntry>>): Promise<void>;
  loadByType(type: CoALAMemoryType): Promise<Record<string, MemoryEntry>>;
  saveByType(
    type: CoALAMemoryType,
    data: Record<string, MemoryEntry>,
  ): Promise<void>;
}

export interface TUIState {
  currentTab: CoALAMemoryType;
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

export interface OverlayContent {
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
  type: CoALAMemoryType;
  title: string;
  count: number;
  color: string;
}

export interface EditState {
  entryId: string;
  currentField: EditableField;
  fieldValues: Record<string, unknown>;
  originalEntry: MemoryEntry;
}

export enum EditableField {
  CONTENT = "content",
  TAGS = "tags",
  RELEVANCE_SCORE = "relevanceScore",
  CONFIDENCE = "confidence",
  ASSOCIATIONS = "associations",
}

// Workspace selection types
export interface WorkspaceEntry {
  id: string;
  name: string;
  path: string;
  description?: string;
}

export interface WorkspaceSelectionState {
  availableWorkspaces: WorkspaceEntry[];
  selectedWorkspaceIndex: number;
  loading: boolean;
  error?: string;
}
