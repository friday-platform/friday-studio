/**
 * In-memory storage for research results.
 * Summaries are read by report generator, raw data used for citations.
 */

export interface SearchSummary {
  summary: string;
  query: string;
  sourceCount: number;
  rawDataKey?: string; // Key to raw data for URL extraction
}

export interface TaskMetadata {
  taskId: string;
  topic: string;
}

/** Stores research data in memory for a single research session */
class ResearchMemoryStore {
  private summaries: SearchSummary[] = [];
  private rawData = new Map<string, unknown>();
  private tasks: TaskMetadata[] = [];

  addSummary(summary: SearchSummary): void {
    this.summaries.push(summary);
  }

  storeRaw(key: string, data: unknown): void {
    this.rawData.set(key, data);
  }

  /** Get all summaries for report generation */
  getAllSummaries(): SearchSummary[] {
    return this.summaries;
  }

  /** Get raw data by key for URL extraction */
  getRaw(key: string): unknown {
    return this.rawData.get(key);
  }

  getRawKeys(): string[] {
    return Array.from(this.rawData.keys());
  }

  addTask(task: TaskMetadata): void {
    this.tasks.push(task);
  }

  getTasks(): TaskMetadata[] {
    return this.tasks;
  }

  private idCounter = 0;

  /** Generate unique ID with prefix */
  generateId(prefix: string): string {
    return `${prefix}_${++this.idCounter}`;
  }
}

export const memoryStore = new ResearchMemoryStore();
