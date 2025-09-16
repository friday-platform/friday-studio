export interface OpenFilesReport {
  pid: number;
  files: OpenFileEntry[];
  byType: Record<string, number>;
  timeMs: number;
  error?: string;
}

export type FileType = "REG" | "DIR" | "PIPE" | "SOCK" | "CHR" | "BLK" | "UNKNOWN";

export interface OpenFileEntry {
  fd: string;
  type: FileType;
  path?: string;
}

export interface PlatformCollector {
  getOpenFiles(pid: number, signal: AbortSignal): AsyncIterableIterator<OpenFileEntry>;
}
