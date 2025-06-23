/**
 * Memory Manager Types
 *
 * Defines types for the ncurses-based memory navigation tool
 */

export enum MemoryType {
  WORKING = "working",
  EPISODIC = "episodic",
  SEMANTIC = "semantic",
  PROCEDURAL = "procedural",
  VECTOR_SEARCH = "vector-search",
}

export interface MemoryEntry {
  id: string;
  content: unknown;
  timestamp: Date;
  accessCount: number;
  lastAccessed: Date;
  memoryType: MemoryType;
  relevanceScore: number;
  sourceScope: string;
  associations: string[];
  tags: string[];
  confidence: number;
  decayRate: number;
}

export interface VectorSearchResult extends MemoryEntry {
  similarity: number;
  matchedContent: string;
}

export interface MemoryOperations {
  // CRUD operations
  create(
    type: MemoryType,
    key: string,
    content: unknown,
    metadata?: Partial<MemoryEntry>,
  ): Promise<void>;
  read(type: MemoryType, key: string): Promise<MemoryEntry | null>;
  update(
    type: MemoryType,
    key: string,
    updates: Partial<MemoryEntry>,
  ): Promise<void>;
  delete(type: MemoryType, key: string): Promise<void>;

  // List and search
  list(type: MemoryType): Promise<MemoryEntry[]>;
  search(type: MemoryType, query: string): Promise<MemoryEntry[]>;

  // Vector search operations
  vectorSearch(query: string): Promise<VectorSearchResult[]>;

  // Storage operations
  save(): Promise<void>;
  reload(): Promise<void>;
}

export interface MemoryStorage {
  loadAll(): Promise<Record<MemoryType, Record<string, MemoryEntry>>>;
  saveAll(data: Record<MemoryType, Record<string, MemoryEntry>>): Promise<void>;
  loadByType(type: MemoryType): Promise<Record<string, MemoryEntry>>;
  saveByType(
    type: MemoryType,
    data: Record<string, MemoryEntry>,
  ): Promise<void>;
}

export interface TUIState {
  currentTab: MemoryType;
  selectedIndex: number;
  scrollOffset: number;
  searchQuery: string;
  showHelp: boolean;
  mode: "list" | "view" | "edit" | "create" | "delete" | "search" | "vector-search";
  editState?: EditState;
  showOverlay: boolean;
  overlayContent?: OverlayContent;
  vectorSearchQuery?: string;
  vectorSearchResults?: VectorSearchResult[];
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
  type: MemoryType;
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
