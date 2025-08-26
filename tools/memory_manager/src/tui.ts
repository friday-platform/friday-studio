/**
 * Terminal User Interface for Memory Manager
 *
 * Provides an ncurses-like interface for navigating workspace memory
 */

import type { CoALAMemoryEntry, CoALAMemoryManager } from "@atlas/memory";
import {
  CoALAMemoryType,
  type KeyBinding,
  type MemoryEntry,
  type TabInfo,
  type TUIState,
  type VectorSearchResult,
  type WorkspaceEntry,
  type WorkspaceStatus,
} from "../types/memory-types.ts";
import { MemoryManagerWorkspaceService } from "../utils/workspace-manager.ts";

export class MemoryManagerTUI {
  private coalaManager?: CoALAMemoryManager;
  private workspaceService = new MemoryManagerWorkspaceService();
  private state: TUIState = {
    currentTab: CoALAMemoryType.WORKING,
    selectedIndex: 0,
    scrollOffset: 0,
    searchQuery: "",
    showHelp: false,
    mode: "workspace-selector" as const,
    showOverlay: false,
  };
  private running = true;
  private terminalSize = { width: 80, height: 24 };

  constructor(coalaManager?: CoALAMemoryManager) {
    this.coalaManager = coalaManager;
    this.updateTerminalSize();

    // If CoALA manager is provided, skip workspace selection
    if (coalaManager) {
      this.state.mode = "list" as const;
    }
  }

  // Helper methods to map operations to CoALA manager
  private getStats(): Record<
    CoALAMemoryType,
    {
      count: number;
      totalRelevance: number;
      avgRelevance: number;
      mostRecent?: Date;
      oldestEntry?: Date;
    }
  > {
    if (!this.coalaManager) {
      throw new Error("CoALA manager not initialized");
    }

    const stats: Record<
      CoALAMemoryType,
      {
        count: number;
        totalRelevance: number;
        avgRelevance: number;
        mostRecent?: Date;
        oldestEntry?: Date;
      }
    > = {
      [CoALAMemoryType.WORKING]: { count: 0, totalRelevance: 0, avgRelevance: 0 },
      [CoALAMemoryType.EPISODIC]: { count: 0, totalRelevance: 0, avgRelevance: 0 },
      [CoALAMemoryType.SEMANTIC]: { count: 0, totalRelevance: 0, avgRelevance: 0 },
      [CoALAMemoryType.PROCEDURAL]: { count: 0, totalRelevance: 0, avgRelevance: 0 },
      [CoALAMemoryType.CONTEXTUAL]: { count: 0, totalRelevance: 0, avgRelevance: 0 },
    };

    for (const memoryType of Object.values(CoALAMemoryType)) {
      const entries = this.coalaManager.getMemoriesByType(memoryType);
      const timestamps = entries.map((e) => e.timestamp);

      stats[memoryType] = {
        count: entries.length,
        totalRelevance: entries.reduce((sum, e) => sum + e.relevanceScore, 0),
        avgRelevance:
          entries.length > 0
            ? entries.reduce((sum, e) => sum + e.relevanceScore, 0) / entries.length
            : 0,
        mostRecent:
          timestamps.length > 0
            ? new Date(Math.max(...timestamps.map((t) => t.getTime())))
            : undefined,
        oldestEntry:
          timestamps.length > 0
            ? new Date(Math.min(...timestamps.map((t) => t.getTime())))
            : undefined,
      };
    }

    return stats;
  }

  private list(type: CoALAMemoryType): MemoryEntry[] {
    if (!this.coalaManager) {
      throw new Error("CoALA manager not initialized");
    }

    const entries = this.coalaManager.getMemoriesByType(type);
    return entries.sort((a, b) => b.lastAccessed.getTime() - a.lastAccessed.getTime());
  }

  private async search(type: CoALAMemoryType, query: string): Promise<MemoryEntry[]> {
    if (!this.coalaManager) {
      throw new Error("CoALA manager not initialized");
    }

    try {
      const searchResults = await this.coalaManager.queryMemoriesEnhanced({
        content: query,
        memoryType: type,
        minRelevance: 0.1,
        limit: 50,
      });
      return searchResults;
    } catch (error) {
      console.error(`Search failed for type ${type}:`, error);
      return [];
    }
  }

  private async vectorSearch(query: string): Promise<VectorSearchResult[]> {
    if (!this.coalaManager) {
      throw new Error("CoALA manager not initialized");
    }

    try {
      const results = await this.coalaManager.getRelevantMemoriesForPrompt(query, {
        includeWorking: false,
        includeEpisodic: true,
        includeSemantic: true,
        includeProcedural: true,
        limit: 20,
        minSimilarity: 0.2,
        maxAge: undefined,
        tags: undefined,
      });

      return results.memories
        .map((memory: CoALAMemoryEntry): VectorSearchResult => {
          const memoryWithSimilarity = memory as CoALAMemoryEntry & { similarity?: number };
          return {
            ...memory,
            similarity: memoryWithSimilarity.similarity || 0,
            matchedContent:
              typeof memory.content === "string"
                ? memory.content.substring(0, 200) + (memory.content.length > 200 ? "..." : "")
                : JSON.stringify(memory.content).substring(0, 200) + "...",
          };
        })
        .sort((a, b) => b.similarity - a.similarity);
    } catch (error) {
      console.error("Vector search failed:", error);
      return [];
    }
  }

  private getAllByType(type: CoALAMemoryType): Record<string, MemoryEntry> {
    if (!this.coalaManager) {
      throw new Error("CoALA manager not initialized");
    }

    const entries = this.coalaManager.getMemoriesByType(type);
    const result: Record<string, MemoryEntry> = {};
    entries.forEach((entry) => {
      result[entry.id] = entry;
    });
    return result;
  }

  private async reload(): Promise<void> {
    if (!this.coalaManager) {
      throw new Error("CoALA manager not initialized");
    }
    await this.coalaManager.loadFromStorage();
  }

  private async save(): Promise<void> {
    if (!this.coalaManager) {
      throw new Error("CoALA manager not initialized");
    }
    await this.coalaManager.commitToStorage();
  }

  /**
   * Start workspace selection mode
   */
  async selectWorkspace(): Promise<WorkspaceEntry | null> {
    // Setup terminal for workspace selection
    this.setupTerminal();

    try {
      // Initialize workspace selection state
      await this.initializeWorkspaceSelection();

      // Run selection loop
      return await this.workspaceSelectionLoop();
    } finally {
      this.restoreTerminal();
    }
  }

  async start(): Promise<void> {
    // Hide cursor and setup raw mode
    this.setupTerminal();

    try {
      await this.renderLoop();
    } finally {
      this.restoreTerminal();
    }
  }

  private async renderLoop(): Promise<void> {
    while (this.running) {
      await this.render();
      await this.handleInput();
    }
  }

  private async render(): Promise<void> {
    // Clear screen
    this.clearScreen();

    // Update terminal size
    this.updateTerminalSize();

    if (this.state.showOverlay) {
      await this.renderOverlay();
    } else if (this.state.showHelp) {
      this.renderHelp();
    } else {
      await this.renderMain();
    }
  }

  private async renderMain(): Promise<void> {
    // Render header
    await this.renderHeader();

    // Render tabs
    await this.renderTabs();

    // Render current content based on mode
    switch (this.state.mode) {
      case "workspace-selector":
        await this.renderWorkspaceSelector();
        break;
      case "list":
        await this.renderMemoryList();
        break;
      case "view":
        await this.renderMemoryView();
        break;
      case "edit":
        await this.renderMemoryEdit();
        break;
      case "create":
        await this.renderMemoryCreate();
        break;
      case "delete":
        await this.renderMemoryDelete();
        break;
      case "search":
        await this.renderSearch();
        break;
      case "vector-search":
        await this.renderVectorSearch();
        break;
    }

    // Render footer with key bindings
    this.renderFooter();
  }

  private async renderHeader(): Promise<void> {
    const title = "Atlas Memory Manager";
    let headerText: string;

    if (this.state.mode === "workspace-selector") {
      headerText = `${title} | Workspace Selection`;
    } else if (this.state.currentTab === "vector-search") {
      const resultCount = this.state.vectorSearchResults?.length || 0;
      headerText = `${title} | VECTOR SEARCH (${resultCount} results)`;
    } else if (this.coalaManager) {
      const stats = this.getStats();
      const currentStats = stats[this.state.currentTab as CoALAMemoryType];
      if (currentStats) {
        headerText = `${title} | ${(
          this.state.currentTab as string
        ).toUpperCase()} Memory (${currentStats.count} entries)`;
      } else {
        headerText = `${title} | ${(this.state.currentTab as string).toUpperCase()} Memory`;
      }
    } else {
      headerText = title;
    }

    console.log(this.colorize(headerText, "bold", "blue"));
    console.log("─".repeat(this.terminalSize.width));
  }

  private async renderTabs(): Promise<void> {
    // Skip tabs in workspace selector mode
    if (this.state.mode === "workspace-selector") {
      console.log(this.colorize("Select a workspace to access its memory", "dim"));
      console.log("─".repeat(this.terminalSize.width));
      return;
    }

    if (!this.coalaManager) {
      return;
    }

    const tabs: TabInfo[] = [
      { type: CoALAMemoryType.WORKING, title: "Working", count: 0, color: "yellow" },
      { type: CoALAMemoryType.EPISODIC, title: "Episodic", count: 0, color: "green" },
      { type: CoALAMemoryType.SEMANTIC, title: "Semantic", count: 0, color: "blue" },
      { type: CoALAMemoryType.PROCEDURAL, title: "Procedural", count: 0, color: "magenta" },
      {
        type: "vector-search" as any, // Special search mode, not a real memory type
        title: "Vector Search",
        count: 0,
        color: "cyan",
      },
    ];

    const stats = await this.getStats();
    tabs.forEach((tab) => {
      if (tab.type === "vector-search") {
        // Vector search shows count of search results, not stored memories
        tab.count = this.state.vectorSearchResults?.length || 0;
      } else {
        // Only access stats for real memory types
        const realMemoryType = tab.type as CoALAMemoryType;
        if (stats[realMemoryType]) {
          tab.count = stats[realMemoryType].count;
        } else {
          tab.count = 0;
        }
      }
    });

    let tabsLine = "";
    tabs.forEach((tab, index) => {
      const isActive = tab.type === this.state.currentTab;
      const tabText = ` ${tab.title} (${tab.count}) `;

      if (isActive) {
        tabsLine += this.colorize(tabText, "bold", "white", tab.color);
      } else {
        tabsLine += this.colorize(tabText, "dim", tab.color);
      }

      if (index < tabs.length - 1) {
        tabsLine += " │ ";
      }
    });

    console.log(tabsLine);
    console.log("─".repeat(this.terminalSize.width));
  }

  private async renderMemoryList(): Promise<void> {
    // Handle vector search tab differently
    if (this.state.currentTab === "vector-search") {
      await this.renderVectorSearchList();
      return;
    }

    const entries = this.list(this.state.currentTab as CoALAMemoryType);
    const visibleHeight = this.terminalSize.height - 8; // Account for header, tabs, footer

    if (entries.length === 0) {
      console.log(this.colorize("No memories found in this category", "dim"));
      return;
    }

    // Adjust scroll offset if needed
    this.state.scrollOffset = Math.max(
      0,
      Math.min(this.state.scrollOffset, entries.length - visibleHeight),
    );

    const visibleEntries = entries.slice(
      this.state.scrollOffset,
      this.state.scrollOffset + visibleHeight,
    );

    visibleEntries.forEach((entry, index) => {
      const absoluteIndex = this.state.scrollOffset + index;
      const isSelected = absoluteIndex === this.state.selectedIndex;

      const relevanceBar = "█".repeat(Math.ceil(entry.relevanceScore * 10));
      const ageInHours = Math.floor((Date.now() - entry.lastAccessed.getTime()) / (1000 * 60 * 60));
      const ageText = ageInHours < 1 ? "< 1h" : `${ageInHours}h`;

      let line = `${entry.id.padEnd(25)} │ ${relevanceBar.padEnd(10)} │ ${ageText.padEnd(6)} │ ${entry.tags
        .slice(0, 3)
        .join(", ")}`;

      if (line.length > this.terminalSize.width - 2) {
        line = line.substring(0, this.terminalSize.width - 5) + "...";
      }

      if (isSelected) {
        console.log(this.colorize(`> ${line}`, "bold", "white", "blue"));
      } else {
        console.log(`  ${line}`);
      }
    });

    // Show scroll indicator
    if (entries.length > visibleHeight) {
      console.log(
        `\nShowing ${this.state.scrollOffset + 1}-${Math.min(
          this.state.scrollOffset + visibleHeight,
          entries.length,
        )} of ${entries.length}`,
      );
    }
  }

  private async renderMemoryView(): Promise<void> {
    let entry: MemoryEntry | VectorSearchResult | undefined;

    if (this.state.currentTab === "vector-search" && this.state.vectorSearchResults) {
      entry = this.state.vectorSearchResults[this.state.selectedIndex];
    } else {
      const entries = this.list(this.state.currentTab as CoALAMemoryType);
      entry = entries[this.state.selectedIndex];
    }

    if (!entry) {
      console.log(this.colorize("No entry selected", "red"));
      return;
    }

    const width = Math.max(Math.min(this.terminalSize.width - 4, 100), 50);
    const titleWidth = width;

    // Header
    const headerText = `┌─ Memory Entry: ${entry.id} `;
    const headerPadding = Math.max(0, titleWidth - headerText.length - 1);
    console.log(this.colorize(headerText + "─".repeat(headerPadding) + "┐", "bold", "cyan"));

    // Metadata table with conditional similarity row
    const tableData = [
      ["Property", "Value"],
      ["─".repeat(Math.max(1, 20)), "─".repeat(Math.max(1, 30))],
      [
        "Type",
        this.colorize(
          entry.memoryType.toUpperCase(),
          "bold",
          this.getMemoryTypeColor(entry.memoryType),
        ),
      ],
      [
        "Relevance",
        this.renderProgressBar(entry.relevanceScore, 20) +
          ` ${(entry.relevanceScore * 100).toFixed(1)}%`,
      ],
    ];

    // Add similarity row for vector search results
    if ("similarity" in entry && entry.similarity !== undefined) {
      tableData.push([
        "Similarity",
        this.renderProgressBar(entry.similarity, 20) + ` ${(entry.similarity * 100).toFixed(1)}%`,
      ]);
    }

    tableData.push(
      [
        "Confidence",
        this.renderProgressBar(entry.confidence, 20) + ` ${(entry.confidence * 100).toFixed(1)}%`,
      ],
      ["Created", this.formatDate(entry.timestamp)],
      ["Source Scope", this.truncateString(entry.sourceScope, 30)],
      ["Decay Rate", entry.decayRate.toFixed(3)],
    );

    this.renderTable(tableData, width);

    // Tags section
    if (entry.tags.length > 0) {
      console.log(
        this.colorize("\n├─ Tags " + "─".repeat(Math.max(0, width - 8)), "bold", "yellow"),
      );
      const tagLine = entry.tags.map((tag) => this.colorize(`#${tag}`, "dim", "yellow")).join("  ");
      console.log(`│ ${tagLine}`);
    }

    // Content section
    console.log(
      this.colorize("\n├─ Content " + "─".repeat(Math.max(0, width - 11)), "bold", "green"),
    );
    this.renderContent(entry.content, width);

    // Footer
    console.log(this.colorize("└" + "─".repeat(Math.max(0, width - 1)) + "┘", "bold", "cyan"));
  }

  private renderTable(rows: string[][], maxWidth: number): void {
    if (rows.length === 0) return;

    // Calculate column widths
    const colCount = Math.max(...rows.map((row) => row.length));
    const colWidths: number[] = new Array(colCount).fill(0);

    rows.forEach((row) => {
      row.forEach((cell, i) => {
        // Remove ANSI codes for length calculation
        const cleanCell = cell.replace(/\\x1b\[[0-9;]*m/g, "");
        colWidths[i] = Math.max(colWidths[i] || 0, cleanCell.length);
      });
    });

    // Adjust widths to fit terminal
    const totalPadding = colCount * 3 + 4; // spaces and borders
    const availableWidth = maxWidth - totalPadding;
    const totalDesiredWidth = colWidths.reduce((sum, w) => sum + w, 0);

    if (totalDesiredWidth > availableWidth) {
      const ratio = availableWidth / totalDesiredWidth;
      colWidths.forEach((width, i) => {
        colWidths[i] = Math.max(10, Math.floor(width * ratio));
      });
    }

    // Render rows
    rows.forEach((row, rowIndex) => {
      let line = "│ ";
      row.forEach((cell, colIndex) => {
        const cleanCell = cell.replace(/\\x1b\[[0-9;]*m/g, "");
        const padding = Math.max(0, colWidths[colIndex] || 0 - cleanCell.length);

        if (rowIndex === 1) {
          // Separator row
          line += cell.substring(0, colWidths[colIndex]);
        } else {
          line += cell + " ".repeat(padding);
        }

        if (colIndex < row.length - 1) {
          line += " │ ";
        }
      });
      line += " │";
      console.log(line);
    });
  }

  private renderContent(content: CoALAMemoryEntry, maxWidth: number): void {
    const safeMaxWidth = Math.max(10, maxWidth);

    if (typeof content === "string") {
      // Handle string content
      this.renderStringContent(content, safeMaxWidth);
    } else if (typeof content === "object" && content !== null) {
      // Handle object content
      this.renderObjectContent(content, safeMaxWidth);
    } else {
      // Handle primitive content
      console.log(`│ ${String(content)}`);
    }
  }

  private renderStringContent(content: string, maxWidth: number): void {
    const lines = content.split("\n");
    lines.forEach((line) => {
      if (line.length <= maxWidth - 4) {
        console.log(`│ ${line}`);
      } else {
        // Wrap long lines
        const words = line.split(" ");
        let currentLine = "";

        words.forEach((word) => {
          if ((currentLine + " " + word).length <= maxWidth - 4) {
            currentLine += (currentLine ? " " : "") + word;
          } else {
            if (currentLine) console.log(`│ ${currentLine}`);
            currentLine = word;
          }
        });

        if (currentLine) console.log(`│ ${currentLine}`);
      }
    });
  }

  private renderObjectContent(content: any, maxWidth: number): void {
    if (Array.isArray(content)) {
      // Handle arrays
      console.log(`│ ${this.colorize(`Array (${content.length} items):`, "bold")}`);
      content.slice(0, 10).forEach((item, index) => {
        const itemStr = typeof item === "object" ? JSON.stringify(item) : String(item);
        const truncated = this.truncateString(itemStr, maxWidth - 8);
        console.log(`│   [${index}] ${truncated}`);
      });

      if (content.length > 10) {
        console.log(`│   ... and ${content.length - 10} more items`);
      }
    } else {
      // Handle objects
      const entries = Object.entries(content);
      console.log(`│ ${this.colorize(`Object (${entries.length} properties):`, "bold")}`);

      entries.slice(0, 15).forEach(([key, value]) => {
        const valueStr = typeof value === "object" ? JSON.stringify(value) : String(value);
        const truncatedValue = this.truncateString(valueStr, maxWidth - key.length - 8);
        console.log(`│   ${this.colorize(key, "bold", "cyan")}: ${truncatedValue}`);
      });

      if (entries.length > 15) {
        console.log(`│   ... and ${entries.length - 15} more properties`);
      }
    }
  }

  private renderProgressBar(value: number, width: number): string {
    const safeWidth = Math.max(1, width);
    const clampedValue = Math.max(0, Math.min(1, value));
    const filled = Math.round(clampedValue * safeWidth);
    const empty = Math.max(0, safeWidth - filled);
    const bar = "█".repeat(filled) + "░".repeat(empty);

    if (clampedValue > 0.8) return this.colorize(bar, "", "green");
    if (clampedValue > 0.5) return this.colorize(bar, "", "yellow");
    return this.colorize(bar, "", "red");
  }

  private formatDate(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    let relative = "";
    if (diffMinutes < 1) relative = "just now";
    else if (diffMinutes < 60) relative = `${diffMinutes}m ago`;
    else if (diffHours < 24) relative = `${diffHours}h ago`;
    else if (diffDays < 7) relative = `${diffDays}d ago`;
    else relative = "over a week ago";

    return `${date.toLocaleString()} (${relative})`;
  }

  private getMemoryTypeColor(type: string): string {
    switch (type) {
      case "working":
        return "yellow";
      case "episodic":
        return "green";
      case "semantic":
        return "blue";
      case "procedural":
        return "magenta";
      case "vector-search":
        return "cyan";
      default:
        return "white";
    }
  }

  private truncateString(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + "...";
  }

  private async renderMemoryEdit(): Promise<void> {
    console.log(this.colorize("Edit Memory Entry", "bold", "yellow"));
    console.log("Use arrow keys to navigate, Enter to confirm, Esc to cancel");
    // Implementation would depend on having a proper input system
    console.log("Edit mode not yet implemented in this simple version");
  }

  private async renderMemoryCreate(): Promise<void> {
    console.log(this.colorize("Create New Memory Entry", "bold", "green"));
    console.log("Create mode not yet implemented in this simple version");
  }

  private async renderMemoryDelete(): Promise<void> {
    console.log(this.colorize("Delete Memory Entry", "bold", "red"));
    console.log("Delete mode not yet implemented in this simple version");
  }

  private async renderSearch(): Promise<void> {
    console.log(this.colorize("Search Memory", "bold", "cyan"));
    console.log(`Query: ${this.state.searchQuery}_`);

    if (this.state.searchQuery.length > 0) {
      const results = await this.search(
        this.state.currentTab as CoALAMemoryType,
        this.state.searchQuery,
      );
      console.log(`Found ${results.length} results:`);

      results.slice(0, 10).forEach((entry, index) => {
        const isSelected = index === this.state.selectedIndex;
        const line = `${entry.id} - ${entry.relevanceScore.toFixed(2)}`;

        if (isSelected) {
          console.log(this.colorize(`> ${line}`, "bold", "white", "blue"));
        } else {
          console.log(`  ${line}`);
        }
      });
    }
  }

  private async renderVectorSearch(): Promise<void> {
    console.log(this.colorize("Vector Search Memory", "bold", "cyan"));
    console.log(`Query: ${this.state.vectorSearchQuery || ""}_`);
    console.log(
      this.colorize("Searches across EPISODIC, SEMANTIC, and PROCEDURAL memories", "dim"),
    );

    if (this.state.vectorSearchQuery && this.state.vectorSearchQuery.length > 0) {
      if (!this.state.vectorSearchResults) {
        console.log(this.colorize("Performing vector search...", "dim", "yellow"));
        this.state.vectorSearchResults = await this.vectorSearch(this.state.vectorSearchQuery);
      }

      const results = this.state.vectorSearchResults;
      console.log(`Found ${results.length} results:`);

      const visibleHeight = this.terminalSize.height - 12; // Account for header, tabs, footer, query display
      const visibleResults = results.slice(0, visibleHeight);

      visibleResults.forEach((entry, index) => {
        const isSelected = index === this.state.selectedIndex;
        const similarityBar = "█".repeat(Math.ceil(entry.similarity * 10));
        const typeColor = this.getMemoryTypeColor(entry.memoryType);

        let line = `[${entry.memoryType.toUpperCase()}] ${entry.id} │ ${similarityBar} ${(
          entry.similarity * 100
        ).toFixed(1)}% │ ${entry.matchedContent}`;

        if (line.length > this.terminalSize.width - 2) {
          line = line.substring(0, this.terminalSize.width - 5) + "...";
        }

        if (isSelected) {
          console.log(this.colorize(`> ${line}`, "bold", "white", "blue"));
        } else {
          console.log(`  ${this.colorize(line, "", typeColor)}`);
        }
      });

      if (results.length > visibleHeight) {
        console.log(`\nShowing first ${visibleHeight} of ${results.length} results`);
      }
    } else {
      console.log(
        this.colorize("Enter a search query to find semantically similar memories", "dim"),
      );
      console.log(this.colorize("Uses vector embeddings for better semantic matching", "dim"));
    }
  }

  private async renderVectorSearchList(): Promise<void> {
    if (!this.state.vectorSearchQuery || this.state.vectorSearchQuery.length === 0) {
      console.log(this.colorize("Vector Search", "bold", "cyan"));
      console.log(this.colorize("Press 'v' to enter vector search mode", "dim"));
      console.log(
        this.colorize(
          "Searches across EPISODIC, SEMANTIC, and PROCEDURAL memories using vector embeddings",
          "dim",
        ),
      );
      return;
    }

    const results = this.state.vectorSearchResults || [];
    const visibleHeight = this.terminalSize.height - 8;

    if (results.length === 0) {
      console.log(this.colorize("No vector search results found", "dim"));
      console.log(this.colorize("Try a different query or check that memories are indexed", "dim"));
      return;
    }

    // Adjust scroll offset if needed
    this.state.scrollOffset = Math.max(
      0,
      Math.min(this.state.scrollOffset, results.length - visibleHeight),
    );

    const visibleResults = results.slice(
      this.state.scrollOffset,
      this.state.scrollOffset + visibleHeight,
    );

    visibleResults.forEach((entry, index) => {
      const absoluteIndex = this.state.scrollOffset + index;
      const isSelected = absoluteIndex === this.state.selectedIndex;

      const similarityBar = "█".repeat(Math.ceil(entry.similarity * 10));
      const typeColor = this.getMemoryTypeColor(entry.memoryType);
      const ageInHours = Math.floor((Date.now() - entry.timestamp.getTime()) / (1000 * 60 * 60));
      const ageText = ageInHours < 1 ? "< 1h" : `${ageInHours}h`;

      let line = `[${entry.memoryType.toUpperCase()}] ${entry.id.padEnd(20)} │ ${similarityBar.padEnd(
        10,
      )} │ ${(entry.similarity * 100).toFixed(1)}% │ ${ageText.padEnd(6)} │ ${entry.tags
        .slice(0, 2)
        .join(", ")}`;

      if (line.length > this.terminalSize.width - 2) {
        line = line.substring(0, this.terminalSize.width - 5) + "...";
      }

      if (isSelected) {
        console.log(this.colorize(`> ${line}`, "bold", "white", "blue"));
      } else {
        console.log(`  ${this.colorize(line, "", typeColor)}`);
      }
    });

    // Show scroll indicator
    if (results.length > visibleHeight) {
      console.log(
        `\nShowing ${this.state.scrollOffset + 1}-${Math.min(
          this.state.scrollOffset + visibleHeight,
          results.length,
        )} of ${results.length} vector search results`,
      );
    }
  }

  private renderHelp(): void {
    console.log(this.colorize("Atlas Memory Manager - Help", "bold", "white"));
    console.log("─".repeat(this.terminalSize.width));

    const keyBindings: KeyBinding[] = [
      { key: "Tab / Shift+Tab", description: "Switch between memory types", action: () => {} },
      {
        key: "↑/↓ or j/k",
        description: "Navigate up/down (arrow keys only in vector search mode)",
        action: () => {},
      },
      { key: "Enter", description: "View selected entry (formatted)", action: () => {} },
      { key: "e", description: "Edit selected entry", action: () => {} },
      { key: "n", description: "Create new entry", action: () => {} },
      { key: "d", description: "Delete selected entry", action: () => {} },
      { key: "/", description: "Search in current memory type", action: () => {} },
      {
        key: "v",
        description: "Vector search mode (most keys disabled during search for typing)",
        action: () => {},
      },
      { key: "r", description: "Reload memory from disk", action: () => {} },
      { key: "s", description: "Save changes to disk", action: () => {} },
      { key: "f", description: "View full content in overlay", action: () => {} },
      { key: "h or ?", description: "Show/hide this help", action: () => {} },
      { key: "q", description: "Quit", action: () => {} },
    ];

    keyBindings.forEach((binding) => {
      console.log(`  ${binding.key.padEnd(15)} - ${binding.description}`);
    });

    console.log("\n" + "─".repeat(this.terminalSize.width));
    console.log(this.colorize("VECTOR SEARCH MODE:", "bold", "cyan"));
    console.log("  ESC, Tab, Arrow keys work normally for navigation");
    console.log("  All other keys (q,e,n,d,s,r,f,v,h,/,j,k, etc.) are used for typing");
    console.log("  This allows typing queries like 'question', 'environment', 'search'");
    console.log("\n" + "─".repeat(this.terminalSize.width));
    console.log("Press any key to return to memory view");
  }

  private renderFooter(): void {
    const modeText = this.state.mode.toUpperCase();
    let footer: string;

    if (this.state.mode === "workspace-selector") {
      footer = `${modeText} | h:help q:quit ↑↓:navigate Enter:select`;
    } else {
      footer = `${modeText} | h:help q:quit ↑↓:navigate Tab:switch Enter:view f:overlay e:edit n:new d:delete /:search v:vector r:reload s:save`;
    }

    console.log("\n" + "─".repeat(this.terminalSize.width));
    console.log(this.colorize(footer, "dim"));
  }

  private async handleInput(): Promise<void> {
    const key = await this.readKey();

    // Handle overlay-specific keys first
    if (this.state.showOverlay) {
      switch (key) {
        case "ESCAPE":
          this.closeOverlay();
          break;
        case "ARROW_UP":
        case "k":
        case "K":
          this.scrollOverlay(-1);
          break;
        case "ARROW_DOWN":
        case "j":
        case "J":
          this.scrollOverlay(1);
          break;
        case "q":
          this.running = false;
          break;
        // Ignore other keys in overlay mode
      }
      return;
    }

    // Handle vector search input first to prevent conflicts with navigation keys
    if (this.state.mode === "vector-search") {
      // Handle ONLY essential navigation keys in vector search mode
      // All other keys should go to text input to allow typing words like "question", "environment", etc.
      if (key === "ESCAPE") {
        this.state.mode = "list" as const;
        this.state.showHelp = false;
        this.state.vectorSearchQuery = undefined;
        this.state.vectorSearchResults = undefined;
        return;
      } else if (key === "\t") {
        // Tab
        this.switchTab(1);
        return;
      } else if (key === "SHIFT_TAB") {
        this.switchTab(-1);
        return;
      } else if (key === "ARROW_UP") {
        // Navigate up in vector search results
        if (this.state.vectorSearchResults && this.state.vectorSearchResults.length > 0) {
          this.navigateUp();
        }
        return;
      } else if (key === "ARROW_DOWN") {
        // Navigate down in vector search results
        if (this.state.vectorSearchResults && this.state.vectorSearchResults.length > 0) {
          await this.navigateDown();
        }
        return;
      } else if (key === "\r") {
        // Enter
        // If we have results, view selected one; otherwise perform search
        if (this.state.vectorSearchResults && this.state.vectorSearchResults.length > 0) {
          this.state.mode = "view" as const;
        } else {
          // Perform vector search
          await this.handleVectorSearchInput(key);
        }
        return;
      } else {
        // ALL other keys (including q,e,n,d,s,r,f,v,h,/,j,k,etc.) go to text input
        // This allows typing words like "question", "environment", "search", "define", etc.
        await this.handleVectorSearchInput(key);
        return;
      }
    }

    // Normal mode key handling
    switch (key) {
      case "q":
        this.running = false;
        break;
      case "h":
      case "?":
        this.state.showHelp = !this.state.showHelp;
        break;
      case "\t": // Tab
        this.switchTab(1);
        break;
      case "SHIFT_TAB":
        this.switchTab(-1);
        break;
      case "j":
      case "J":
      case "ARROW_DOWN":
        await this.navigateDown();
        break;
      case "k":
      case "K":
      case "ARROW_UP":
        this.navigateUp();
        break;
      case "\r": // Enter
        if (this.state.mode === "list") {
          this.state.mode = "view" as const;
        } else {
          this.state.mode = "list" as const;
        }
        break;
      case "f":
      case "F":
        // Show full content overlay for current entry
        await this.showCurrentEntryOverlay();
        break;
      case "e":
        this.state.mode = this.state.mode === "edit" ? ("list" as const) : ("edit" as const);
        break;
      case "n":
        this.state.mode = this.state.mode === "create" ? ("list" as const) : ("create" as const);
        break;
      case "d":
        this.state.mode = this.state.mode === "delete" ? ("list" as const) : ("delete" as const);
        break;
      case "/":
        this.state.mode = this.state.mode === "search" ? ("list" as const) : ("search" as const);
        break;
      case "v":
        if (this.state.currentTab === "vector-search") {
          const currentMode = this.state.mode as
            | "list"
            | "view"
            | "edit"
            | "create"
            | "delete"
            | "search"
            | "vector-search";
          if (currentMode === "vector-search") {
            this.state.mode = "list" as const;
          } else {
            this.state.mode = "vector-search" as const;
          }
        } else {
          // Switch to vector search tab and enter vector search mode
          this.state.currentTab = "vector-search" as any;
          this.state.mode = "vector-search" as const;
          this.state.selectedIndex = 0;
          this.state.scrollOffset = 0;
        }
        break;
      case "r":
        await this.reload();
        break;
      case "s":
        await this.save();
        break;
      case "ESCAPE":
        this.state.mode = "list" as const;
        this.state.showHelp = false;
        break;
      default:
        // All other keys are ignored in normal mode
        break;
    }
  }

  private async handleVectorSearchInput(key: string): Promise<void> {
    if (!this.state.vectorSearchQuery) {
      this.state.vectorSearchQuery = "";
    }

    if (key === "\b" || key === "\x7f") {
      // Backspace
      if (this.state.vectorSearchQuery.length > 0) {
        this.state.vectorSearchQuery = this.state.vectorSearchQuery.slice(0, -1);
        this.state.vectorSearchResults = undefined; // Clear results to trigger new search
      }
    } else if (key === "\r") {
      // Enter - perform search
      if (this.state.vectorSearchQuery && this.state.vectorSearchQuery.length > 0) {
        this.state.vectorSearchResults = await this.vectorSearch(this.state.vectorSearchQuery);
        this.state.selectedIndex = 0;
        this.state.scrollOffset = 0;
      }
    } else if (key >= " " && key <= "~") {
      // Printable characters
      this.state.vectorSearchQuery += key;
      this.state.vectorSearchResults = undefined; // Clear results to trigger new search when Enter is pressed
    }
  }

  private async readKey(): Promise<string> {
    const buffer = new Uint8Array(1);
    const bytesRead = await Deno.stdin.read(buffer);

    if (bytesRead === null) return "";

    const firstByte = buffer[0];

    // Handle escape sequences (arrow keys, etc.)
    if (firstByte === 0x1b) {
      // ESC
      // Try to read the next character(s) for escape sequences
      const seqBuffer = new Uint8Array(3);
      let seqLength = 0;

      // Read up to 3 more bytes with a short timeout
      const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 10));

      try {
        while (seqLength < 3) {
          const readPromise = Deno.stdin.read(seqBuffer.subarray(seqLength, seqLength + 1));
          const result = await Promise.race([readPromise, timeoutPromise]);

          if (result === undefined) break; // timeout
          if (result === null) break; // EOF

          seqLength++;

          // Check for complete sequences
          const sequence = new TextDecoder().decode(seqBuffer.subarray(0, seqLength));

          // Arrow keys: ESC[A, ESC[B, ESC[C, ESC[D
          if (sequence === "[A") return "ARROW_UP";
          if (sequence === "[B") return "ARROW_DOWN";
          if (sequence === "[C") return "ARROW_RIGHT";
          if (sequence === "[D") return "ARROW_LEFT";

          // Shift+Tab: ESC[Z
          if (sequence === "[Z") return "SHIFT_TAB";

          // Other common escape sequences
          if (sequence === "OP") return "F1";
          if (sequence === "OQ") return "F2";
          if (sequence === "OR") return "F3";
          if (sequence === "OS") return "F4";
        }
      } catch {
        // If reading additional bytes fails, treat as plain escape
      }

      return "ESCAPE";
    }

    // Handle regular characters
    return String.fromCharCode(firstByte || 0);
  }

  private switchTab(direction: 1 | -1): void {
    // Only include actual memory storage types, not VECTOR_SEARCH which is a search mode
    const types = [
      CoALAMemoryType.WORKING,
      CoALAMemoryType.EPISODIC,
      CoALAMemoryType.SEMANTIC,
      CoALAMemoryType.PROCEDURAL,
    ];

    // If current tab is VECTOR_SEARCH, start from WORKING
    let currentIndex =
      this.state.currentTab === ("vector-search" as any)
        ? 0
        : types.indexOf(this.state.currentTab as CoALAMemoryType);
    if (currentIndex === -1) {
      currentIndex = 0; // fallback to first tab
    }

    const newIndex = (currentIndex + direction + types.length) % types.length;

    this.state.currentTab = types[newIndex] as any;
    this.state.selectedIndex = 0;
    this.state.scrollOffset = 0;
  }

  private navigateUp(): void {
    if (this.state.selectedIndex > 0) {
      this.state.selectedIndex--;

      // Adjust scroll if needed
      if (this.state.selectedIndex < this.state.scrollOffset) {
        this.state.scrollOffset = this.state.selectedIndex;
      }
    }
  }

  private async navigateDown(): Promise<void> {
    let maxIndex: number;

    if (this.state.currentTab === "vector-search" && this.state.vectorSearchResults) {
      maxIndex = this.state.vectorSearchResults.length - 1;
    } else {
      const entries = this.getAllByType(this.state.currentTab as CoALAMemoryType);
      maxIndex = Object.keys(entries).length - 1;
    }

    if (this.state.selectedIndex < maxIndex) {
      this.state.selectedIndex++;

      // Adjust scroll if needed
      const visibleHeight = this.terminalSize.height - 8;
      if (this.state.selectedIndex >= this.state.scrollOffset + visibleHeight) {
        this.state.scrollOffset = this.state.selectedIndex - visibleHeight + 1;
      }
    }
  }

  private colorize(text: string, style?: string, color?: string, bgColor?: string): string {
    // Simple ANSI color implementation
    let result = text;

    // Styles
    if (style === "bold") result = `\x1b[1m${result}`;
    if (style === "dim") result = `\x1b[2m${result}`;

    // Colors
    const colors: Record<string, string> = {
      black: "30",
      red: "31",
      green: "32",
      yellow: "33",
      blue: "34",
      magenta: "35",
      cyan: "36",
      white: "37",
    };

    if (color && colors[color]) {
      result = `\x1b[${colors[color]}m${result}`;
    }

    if (bgColor && colors[bgColor]) {
      result = `\x1b[${parseInt(colors[bgColor]) + 10}m${result}`;
    }

    return `${result}\x1b[0m`; // Reset at end
  }

  private setupTerminal(): void {
    // Hide cursor
    console.log("\x1b[?25l");

    // Enable raw mode (simplified)
    Deno.stdin.setRaw(true);
  }

  private restoreTerminal(): void {
    // Show cursor
    console.log("\x1b[?25h");

    // Disable raw mode
    Deno.stdin.setRaw(false);

    // Clear screen and reset
    console.log("\x1b[2J\x1b[H");
  }

  private clearScreen(): void {
    console.log("\x1b[2J\x1b[H");
  }

  private updateTerminalSize(): void {
    try {
      const size = Deno.consoleSize();
      this.terminalSize = { width: Math.max(50, size.columns), height: Math.max(10, size.rows) };
    } catch {
      // Fallback if consoleSize fails
      this.terminalSize = { width: 80, height: 24 };
    }
  }

  // Overlay rendering methods

  private async renderOverlay(): Promise<void> {
    if (!this.state.overlayContent) {
      console.log(this.colorize("Error: No overlay content to display", "bold", "red"));
      return;
    }

    const { width, height } = this.terminalSize;
    const overlay = this.state.overlayContent;

    // Calculate overlay dimensions (80% of terminal, minimum 60x20)
    const overlayWidth = Math.max(60, Math.floor(width * 0.8));
    const overlayHeight = Math.max(20, Math.floor(height * 0.8));
    const startX = Math.floor((width - overlayWidth) / 2);
    const startY = Math.floor((height - overlayHeight) / 2);

    // Draw overlay background
    await this.drawOverlayBackground(overlayWidth, overlayHeight, startX, startY);

    // Render overlay header
    await this.drawOverlayHeader(overlay.title, overlayWidth, startX, startY);

    // Render scrollable content
    await this.drawOverlayContent(
      overlay.content,
      overlayWidth,
      overlayHeight,
      startX,
      startY,
      overlay.scrollOffset,
    );

    // Render overlay footer with scroll info and controls
    await this.drawOverlayFooter(
      overlayWidth,
      startX,
      startY + overlayHeight - 1,
      overlay.scrollOffset,
      overlay.maxScroll,
    );
  }

  private async drawOverlayBackground(
    width: number,
    height: number,
    startX: number,
    startY: number,
  ): Promise<void> {
    // Draw border
    const topBorder = "┌" + "─".repeat(width - 2) + "┐";
    const bottomBorder = "└" + "─".repeat(width - 2) + "┘";
    const sideBorder = "│" + " ".repeat(width - 2) + "│";

    // Position cursor and draw top border
    await Deno.stdout.write(new TextEncoder().encode(`\x1b[${startY + 1};${startX + 1}H`));
    console.log(this.colorize(topBorder, "bold", "cyan"));

    // Draw side borders
    for (let i = 1; i < height - 1; i++) {
      await Deno.stdout.write(new TextEncoder().encode(`\x1b[${startY + i + 1};${startX + 1}H`));
      console.log(this.colorize(sideBorder, "bold", "cyan"));
    }

    // Draw bottom border
    await Deno.stdout.write(new TextEncoder().encode(`\x1b[${startY + height};${startX + 1}H`));
    console.log(this.colorize(bottomBorder, "bold", "cyan"));
  }

  private async drawOverlayHeader(
    title: string,
    width: number,
    startX: number,
    startY: number,
  ): Promise<void> {
    const headerText = ` ${title} `;
    const padding = Math.max(0, width - headerText.length - 4);
    const leftPadding = Math.floor(padding / 2);
    const rightPadding = padding - leftPadding;

    const header = "├" + "─".repeat(leftPadding) + headerText + "─".repeat(rightPadding) + "┤";

    await Deno.stdout.write(new TextEncoder().encode(`\x1b[${startY + 2};${startX + 1}H`));
    console.log(this.colorize(header, "bold", "yellow"));
  }

  private async drawOverlayContent(
    content: unknown,
    width: number,
    height: number,
    startX: number,
    startY: number,
    scrollOffset: number,
  ): Promise<void> {
    const contentHeight = height - 4; // Account for header, footer, borders
    const contentWidth = width - 4; // Account for borders and padding

    // Convert content to lines with proper wrapping for overlay
    const lines = this.contentToLines(content, contentWidth);

    // Calculate visible lines
    const visibleLines = lines.slice(scrollOffset, scrollOffset + contentHeight);

    // Update max scroll in state
    if (this.state.overlayContent) {
      this.state.overlayContent.maxScroll = Math.max(0, lines.length - contentHeight);
    }

    // Render visible lines without truncation (they're already wrapped)
    for (let index = 0; index < visibleLines.length; index++) {
      const line = visibleLines[index];
      const y = startY + 3 + index;
      await Deno.stdout.write(new TextEncoder().encode(`\x1b[${y};${startX + 3}H`));
      // Lines are already properly wrapped, just display them
      console.log(line?.substring(0, contentWidth) || "");
    }

    // Clear any remaining lines in the content area
    for (let i = visibleLines.length; i < contentHeight; i++) {
      const y = startY + 3 + i;
      await Deno.stdout.write(new TextEncoder().encode(`\x1b[${y};${startX + 3}H`));
      console.log(" ".repeat(contentWidth));
    }
  }

  private async drawOverlayFooter(
    width: number,
    startX: number,
    y: number,
    scrollOffset: number,
    maxScroll: number,
  ): Promise<void> {
    const scrollInfo = maxScroll > 0 ? ` ${scrollOffset + 1}/${Math.max(1, maxScroll + 1)} ` : " ";
    const instructions = " ↑/↓:scroll ESC:close ";
    const footerContent = scrollInfo + instructions;
    const padding = Math.max(0, width - footerContent.length - 4);

    const footer =
      "├" +
      "─".repeat(Math.floor(padding / 2)) +
      footerContent +
      "─".repeat(Math.ceil(padding / 2)) +
      "┤";

    await Deno.stdout.write(new TextEncoder().encode(`\x1b[${y};${startX + 1}H`));
    console.log(this.colorize(footer, "dim", "white"));
  }

  private contentToLines(content: unknown, maxWidth: number): string[] {
    const lines: string[] = [];

    if (typeof content === "string") {
      // Split by newlines and handle word wrapping
      const rawLines = content.split("\n");
      rawLines.forEach((line) => {
        if (line.length <= maxWidth) {
          lines.push(line);
        } else {
          // Word wrap long lines
          const words = line.split(" ");
          let currentLine = "";

          words.forEach((word) => {
            if ((currentLine + " " + word).length <= maxWidth) {
              currentLine += (currentLine ? " " : "") + word;
            } else {
              if (currentLine) lines.push(currentLine);
              currentLine = word.length > maxWidth ? word.substring(0, maxWidth - 3) + "..." : word;
            }
          });

          if (currentLine) lines.push(currentLine);
        }
      });
    } else if (typeof content === "object" && content !== null) {
      // Pretty print JSON with proper formatting
      const jsonString = JSON.stringify(content, null, 2);
      const rawLines = jsonString.split("\n");

      rawLines.forEach((line) => {
        if (line.length <= maxWidth) {
          lines.push(line);
        } else {
          // For JSON, we want to preserve structure but wrap long values
          const indent = line.match(/^(\s*)/)?.[1] || "";
          const contentPart = line.substring(indent.length);

          if (contentPart.length <= maxWidth - indent.length) {
            lines.push(line);
          } else {
            // Wrap long JSON lines while preserving indentation
            let currentIndent = indent;
            let remainingContent = contentPart;

            while (remainingContent.length > 0) {
              const availableWidth = maxWidth - currentIndent.length;

              if (remainingContent.length <= availableWidth) {
                lines.push(currentIndent + remainingContent);
                break;
              }

              // Find a good break point (prefer after comma, space, or quote)
              let breakPoint = availableWidth;
              for (let i = availableWidth - 1; i > availableWidth * 0.7; i--) {
                const char = remainingContent[i];
                if (char === "," || char === " " || char === '"' || char === ":") {
                  breakPoint = i + 1;
                  break;
                }
              }

              lines.push(currentIndent + remainingContent.substring(0, breakPoint));
              remainingContent = remainingContent.substring(breakPoint);

              // Add extra indentation for continuation lines
              currentIndent = indent + "  ";
            }
          }
        }
      });
    } else {
      // Handle primitives
      lines.push(String(content));
    }

    return lines;
  }

  // Method to show overlay with content
  private showOverlay(title: string, content: unknown): void {
    this.state.overlayContent = { title, content, scrollOffset: 0, maxScroll: 0 };
    this.state.showOverlay = true;
  }

  // Show overlay for currently selected memory entry
  private async showCurrentEntryOverlay(): Promise<void> {
    let entry: MemoryEntry | VectorSearchResult | undefined;

    if (this.state.currentTab === "vector-search" && this.state.vectorSearchResults) {
      entry = this.state.vectorSearchResults[this.state.selectedIndex];
    } else {
      const entries = this.list(this.state.currentTab as CoALAMemoryType);
      entry = entries[this.state.selectedIndex];
    }

    if (!entry) {
      return;
    }

    const title = `Full Content: ${entry.id}`;
    this.showOverlay(title, entry.content);
  }

  // Method to close overlay
  private closeOverlay(): void {
    this.state.showOverlay = false;
    this.state.overlayContent = undefined;
  }

  // Scroll overlay content
  private scrollOverlay(direction: 1 | -1): void {
    if (!this.state.overlayContent) return;

    const newOffset = this.state.overlayContent.scrollOffset + direction;
    this.state.overlayContent.scrollOffset = Math.max(
      0,
      Math.min(newOffset, this.state.overlayContent.maxScroll),
    );
  }

  // Workspace selection methods

  /**
   * Initialize workspace selection state
   */
  private async initializeWorkspaceSelection(): Promise<void> {
    this.state.workspaceSelection = {
      availableWorkspaces: [],
      selectedWorkspaceIndex: 0,
      loading: true,
    };

    try {
      const workspaces = await this.workspaceService.listWorkspaces(true);
      this.state.workspaceSelection.availableWorkspaces = workspaces;
      this.state.workspaceSelection.loading = false;

      if (workspaces.length === 0) {
        this.state.workspaceSelection.error =
          "No workspaces found. Please create a workspace first.";
      }
    } catch (error) {
      this.state.workspaceSelection.loading = false;
      this.state.workspaceSelection.error = `Failed to load workspaces: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  /**
   * Run workspace selection loop
   */
  private async workspaceSelectionLoop(): Promise<WorkspaceEntry | null> {
    while (this.running) {
      await this.render();

      if (this.state.mode !== "workspace-selector") {
        // User selected a workspace
        break;
      }

      const selectedWorkspace = await this.handleWorkspaceSelectionInput();
      if (selectedWorkspace) {
        return selectedWorkspace;
      }
    }

    return null;
  }

  /**
   * Render workspace selector
   */
  private async renderWorkspaceSelector(): Promise<void> {
    const selection = this.state.workspaceSelection;

    if (!selection) {
      console.log(this.colorize("Initializing workspace selection...", "dim"));
      return;
    }

    if (selection.loading) {
      console.log(this.colorize("Loading available workspaces...", "dim", "yellow"));
      return;
    }

    if (selection.error) {
      console.log(this.colorize("Error: " + selection.error, "bold", "red"));
      console.log(this.colorize("Press 'q' to quit", "dim"));
      return;
    }

    const workspaces = selection.availableWorkspaces;

    if (workspaces.length === 0) {
      console.log(this.colorize("No workspaces found", "dim"));
      console.log(this.colorize("Press 'q' to quit", "dim"));
      return;
    }

    console.log(this.colorize(`Found ${workspaces.length} workspace(s):`, "bold"));
    console.log("");

    const visibleHeight = this.terminalSize.height - 12; // Account for header, footer, instructions
    const startIndex = Math.max(
      0,
      selection.selectedWorkspaceIndex - Math.floor(visibleHeight / 2),
    );
    const endIndex = Math.min(workspaces.length, startIndex + visibleHeight);

    const visibleWorkspaces = workspaces.slice(startIndex, endIndex);

    visibleWorkspaces.forEach((workspace, index) => {
      const absoluteIndex = startIndex + index;
      const isSelected = absoluteIndex === selection.selectedWorkspaceIndex;

      const statusColor = this.getStatusColor(workspace.status);
      const statusText = workspace.status.toUpperCase();

      let line = `${workspace.name.padEnd(30)} │ ${statusText.padEnd(8)} │ ${workspace.path}`;

      if (workspace.metadata?.description) {
        const maxDescLength = Math.max(20, this.terminalSize.width - line.length - 5);
        const truncatedDesc =
          workspace.metadata.description.length > maxDescLength
            ? workspace.metadata.description.substring(0, maxDescLength - 3) + "..."
            : workspace.metadata.description;
        line += ` │ ${this.colorize(truncatedDesc, "dim")}`;
      }

      if (line.length > this.terminalSize.width - 2) {
        line = line.substring(0, this.terminalSize.width - 5) + "...";
      }

      if (isSelected) {
        console.log(this.colorize(`> ${line}`, "bold", "white", "blue"));
      } else {
        const statusPart = line.includes(statusText)
          ? line.replace(statusText, this.colorize(statusText, "", statusColor))
          : line;
        console.log(`  ${statusPart}`);
      }
    });

    if (workspaces.length > visibleHeight) {
      console.log("");
      console.log(
        this.colorize(
          `Showing ${startIndex + 1}-${endIndex} of ${workspaces.length} workspaces`,
          "dim",
        ),
      );
    }
  }

  /**
   * Handle workspace selection input
   */
  private async handleWorkspaceSelectionInput(): Promise<WorkspaceEntry | null> {
    const key = await this.readKey();
    const selection = this.state.workspaceSelection;

    if (!selection || selection.loading || selection.error) {
      if (key === "q") {
        this.running = false;
      }
      return null;
    }

    const workspaces = selection.availableWorkspaces;

    switch (key) {
      case "q":
        this.running = false;
        return null;

      case "ARROW_UP":
      case "k":
      case "K":
        if (selection.selectedWorkspaceIndex > 0) {
          selection.selectedWorkspaceIndex--;
        }
        break;

      case "ARROW_DOWN":
      case "j":
      case "J":
        if (selection.selectedWorkspaceIndex < workspaces.length - 1) {
          selection.selectedWorkspaceIndex++;
        }
        break;

      case "\r": // Enter
        if (workspaces.length > 0) {
          const selectedWorkspace = workspaces[selection.selectedWorkspaceIndex];
          return selectedWorkspace || null;
        }
        break;

      case "h":
      case "?":
        this.state.showHelp = !this.state.showHelp;
        break;
    }

    return null;
  }

  /**
   * Get color for workspace status
   */
  private getStatusColor(status: WorkspaceStatus): string {
    switch (status) {
      case "running":
        return "green";
      case "stopped":
        return "red";
      case "inactive":
        return "dim";
      default:
        return "white";
    }
  }
}
