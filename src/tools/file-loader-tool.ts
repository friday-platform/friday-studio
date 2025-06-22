/**
 * File Loader Tool for Atlas Agents
 *
 * Provides controlled file loading capabilities for agents with proper
 * glob pattern support and size limits to control spend.
 */

import { expandGlob } from "@std/fs";
import { relative, resolve } from "@std/path";

export interface FileLoaderConfig {
  readonly maxFileSize?: number; // bytes
  readonly maxTotalSize?: number; // bytes
  readonly allowedExtensions?: string[];
  readonly basePath?: string;
}

export interface FileLoadRequest {
  readonly patterns: string[];
  readonly maxFiles?: number;
  readonly includeContent?: boolean;
  readonly includeMetadata?: boolean;
}

export interface FileInfo {
  readonly path: string;
  readonly relativePath: string;
  readonly size: number;
  readonly extension: string;
  readonly lastModified?: Date;
  readonly content?: string;
}

export interface FileLoadResult {
  readonly success: boolean;
  readonly files: FileInfo[];
  readonly totalSize: number;
  readonly truncated: boolean;
  readonly error?: string;
}

export class FileLoaderTool {
  private config: Required<FileLoaderConfig>;

  constructor(config: FileLoaderConfig = {}) {
    this.config = {
      maxFileSize: config.maxFileSize ?? 50 * 1024, // 50KB default
      maxTotalSize: config.maxTotalSize ?? 500 * 1024, // 500KB default
      allowedExtensions: config.allowedExtensions ??
        [".ts", ".js", ".md", ".json", ".yml", ".yaml"],
      basePath: config.basePath ?? ".",
    };
  }

  /**
   * Load files based on glob patterns with controlled limits
   */
  async loadFiles(request: FileLoadRequest): Promise<FileLoadResult> {
    try {
      const files: FileInfo[] = [];
      let totalSize = 0;
      let truncated = false;
      const maxFiles = request.maxFiles ?? 50;

      // Resolve patterns to files
      const matchedPaths = await this.resolvePatterns(request.patterns);

      // Sort for consistent ordering
      matchedPaths.sort();

      // Process files up to limits
      for (const filePath of matchedPaths) {
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }

        if (totalSize >= this.config.maxTotalSize) {
          truncated = true;
          break;
        }

        try {
          const fileInfo = await this.loadFile(
            filePath,
            request.includeContent ?? true,
            request.includeMetadata ?? true,
          );

          if (fileInfo) {
            files.push(fileInfo);
            totalSize += fileInfo.size;

            // Check if we're approaching limits
            if (totalSize >= this.config.maxTotalSize) {
              truncated = true;
              break;
            }
          }
        } catch (error) {
          console.warn(`Failed to load file ${filePath}: ${error}`);
          // Continue with other files
        }
      }

      return {
        success: true,
        files,
        totalSize,
        truncated,
      };
    } catch (error) {
      return {
        success: false,
        files: [],
        totalSize: 0,
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get file list without content (for discovery)
   */
  async listFiles(patterns: string[]): Promise<FileLoadResult> {
    return this.loadFiles({
      patterns,
      includeContent: false,
      includeMetadata: true,
      maxFiles: 100,
    });
  }

  /**
   * Load specific files with full content
   */
  async loadSpecificFiles(filePaths: string[]): Promise<FileLoadResult> {
    const result = await this.loadFiles({
      patterns: filePaths,
      includeContent: true,
      includeMetadata: true,
    });

    return result;
  }

  // Private methods

  private async resolvePatterns(patterns: string[]): Promise<string[]> {
    const allPaths = new Set<string>();

    for (const pattern of patterns) {
      try {
        const fullPattern = this.resolvePattern(pattern);

        if (this.isGlobPattern(pattern)) {
          // Use glob expansion
          for await (
            const entry of expandGlob(fullPattern, {
              root: this.config.basePath,
              includeDirs: false,
              globstar: true,
            })
          ) {
            if (this.isAllowedFile(entry.name)) {
              allPaths.add(entry.path);
            }
          }
        } else {
          // Direct file path
          if (this.isAllowedFile(pattern)) {
            const resolvedPath = resolve(this.config.basePath, pattern);
            try {
              await Deno.stat(resolvedPath);
              allPaths.add(resolvedPath);
            } catch {
              // File doesn't exist, skip
            }
          }
        }
      } catch (error) {
        console.warn(`Failed to resolve pattern ${pattern}: ${error}`);
      }
    }

    return Array.from(allPaths);
  }

  private async loadFile(
    filePath: string,
    includeContent: boolean,
    includeMetadata: boolean,
  ): Promise<FileInfo | null> {
    try {
      const stat = await Deno.stat(filePath);

      if (!stat.isFile) {
        return null;
      }

      if (stat.size > this.config.maxFileSize) {
        console.warn(
          `File ${filePath} exceeds size limit (${stat.size} > ${this.config.maxFileSize})`,
        );
        return null;
      }

      const relativePath = this.getRelativePath(filePath);
      const extension = this.getExtension(filePath);

      let content: string | undefined;
      if (includeContent) {
        content = await Deno.readTextFile(filePath);

        // Truncate if needed
        if (content.length > this.config.maxFileSize) {
          content = content.slice(0, this.config.maxFileSize - 100) + "\n... (truncated)";
        }
      }

      return {
        path: filePath,
        relativePath,
        size: stat.size,
        extension,
        lastModified: includeMetadata ? stat.mtime || undefined : undefined,
        content,
      };
    } catch (error) {
      throw new Error(`Failed to load file ${filePath}: ${error}`);
    }
  }

  private resolvePattern(pattern: string): string {
    if (pattern.startsWith("/")) {
      return pattern; // Absolute path
    }
    return `${this.config.basePath}/${pattern}`;
  }

  private isGlobPattern(pattern: string): boolean {
    return /[*?[\]{}]/.test(pattern);
  }

  private isAllowedFile(filename: string): boolean {
    const ext = this.getExtension(filename);
    return this.config.allowedExtensions.includes(ext);
  }

  private getExtension(filename: string): string {
    const lastDot = filename.lastIndexOf(".");
    return lastDot >= 0 ? filename.slice(lastDot) : "";
  }

  private getRelativePath(absolutePath: string): string {
    try {
      return relative(resolve(this.config.basePath), absolutePath);
    } catch {
      return absolutePath;
    }
  }

  /**
   * Format files as markdown for agent consumption
   */
  formatAsMarkdown(result: FileLoadResult, title = "Loaded Files"): string {
    if (!result.success) {
      return `# ${title}\n\nError: ${result.error}\n`;
    }

    let markdown = `# ${title}\n\n`;

    if (result.files.length === 0) {
      markdown += "No files found matching the specified patterns.\n";
      return markdown;
    }

    markdown += `Loaded ${result.files.length} file(s), total size: ${
      this.formatSize(result.totalSize)
    }`;
    if (result.truncated) {
      markdown += " (truncated due to limits)";
    }
    markdown += "\n\n";

    for (const file of result.files) {
      markdown += `## ${file.relativePath}\n\n`;

      if (file.content) {
        const language = this.getLanguageFromExtension(file.extension);
        markdown += `\`\`\`${language}\n${file.content}\n\`\`\`\n\n`;
      } else {
        markdown += `*File size: ${this.formatSize(file.size)}*\n\n`;
      }
    }

    return markdown;
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  private getLanguageFromExtension(ext: string): string {
    const languages: Record<string, string> = {
      ".ts": "typescript",
      ".js": "javascript",
      ".md": "markdown",
      ".json": "json",
      ".yml": "yaml",
      ".yaml": "yaml",
    };
    return languages[ext] || "text";
  }
}
