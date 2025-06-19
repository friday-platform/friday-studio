/**
 * Filesystem EMCP Provider
 *
 * Provides access to local filesystem resources for codebase analysis
 * Migrated from SessionSupervisor.loadCodebaseContext()
 */

import { BaseEMCPProvider } from "./base-provider.ts";
import { expandGlob } from "jsr:@std/fs";
import { relative, resolve } from "jsr:@std/path";
import type {
  CodebaseContextSpec,
  ContextSpec,
  EMCPContext,
  EMCPProviderConfig,
  EMCPResource,
  EMCPResult,
} from "../emcp-provider.ts";

export interface FilesystemProviderConfig {
  readonly basePath?: string;
  readonly allowedExtensions?: string[];
  readonly maxFileSize?: string;
  readonly maxTotalSize?: string;
}

export class FilesystemProvider extends BaseEMCPProvider {
  public readonly config: EMCPProviderConfig = {
    name: "filesystem",
    version: "1.0.0",
    description: "Local filesystem access for codebase analysis",
    capabilities: [
      {
        type: "codebase",
        operations: ["read", "list", "analyze"],
        formats: ["typescript", "javascript", "markdown", "json", "yaml"],
        constraints: {
          maxSize: "50kb",
          timeout: 30000,
        },
      },
    ],
    costMetrics: {
      processingTime: true,
      dataTransfer: true,
    },
  };

  private basePath = "";
  private allowedExtensions = [".ts", ".js", ".md", ".json", ".yaml", ".yml"];
  private maxFileSize = 4000; // characters
  private maxTotalSize = 50000; // characters

  protected doInitialize(config: Record<string, unknown>): Promise<void> {
    // Extract filesystem-specific configuration
    for (const [_sourceName, sourceConfig] of Object.entries(config)) {
      const fsConfig = sourceConfig as FilesystemProviderConfig;

      if (fsConfig.basePath) {
        this.basePath = fsConfig.basePath;
      }

      if (fsConfig.allowedExtensions) {
        this.allowedExtensions = fsConfig.allowedExtensions;
      }

      if (fsConfig.maxFileSize) {
        this.maxFileSize = this.parseSize(fsConfig.maxFileSize);
      }

      if (fsConfig.maxTotalSize) {
        this.maxTotalSize = this.parseSize(fsConfig.maxTotalSize);
      }
    }

    console.log(
      `Filesystem provider initialized with base path: ${this.basePath || "current directory"}`,
    );
    return Promise.resolve();
  }

  protected async doShutdown(): Promise<void> {
    // No cleanup needed for filesystem provider
  }

  async listResources(_context: EMCPContext): Promise<EMCPResource[]> {
    this.ensureInitialized();

    try {
      const resources: EMCPResource[] = [];
      const searchPath = this.basePath || ".";

      await this.scanDirectory(searchPath, resources);

      return resources;
    } catch (error) {
      console.error("Error listing filesystem resources:", error);
      return [];
    }
  }

  async readResource(uri: string, _context: EMCPContext): Promise<EMCPResult> {
    this.ensureInitialized();

    const startTime = Date.now();

    try {
      const filePath = this.resolveFilePath(uri);
      const content = await Deno.readTextFile(filePath);
      const processingTime = Date.now() - startTime;

      return this.createSuccessResult(
        content,
        undefined,
        this.createCostInfo(processingTime, content.length),
        { filePath, size: content.length },
      );
    } catch (error) {
      const processingTime = Date.now() - startTime;
      return this.createErrorResult(
        `Failed to read file ${uri}: ${error}`,
        this.createCostInfo(processingTime),
      );
    }
  }

  async provisionContext(spec: ContextSpec, _context: EMCPContext): Promise<EMCPResult> {
    this.ensureInitialized();
    this.validateContextSpec(spec, "codebase");

    const codebaseSpec = spec as CodebaseContextSpec;
    const startTime = Date.now();

    try {
      // Extract configuration from job spec (legacy compatibility)
      const filePatterns = codebaseSpec.filePatterns || [];
      const focusAreas = codebaseSpec.focusAreas || [];
      const maxSize = codebaseSpec.maxSize
        ? this.parseSize(codebaseSpec.maxSize)
        : this.maxTotalSize;

      let codebaseContent = "";
      let loadedFilesCount = 0;
      let totalSize = 0;

      // Add focus areas first (migrated from original logic)
      if (focusAreas.length > 0) {
        codebaseContent += `# Analysis Focus Areas\n\n`;
        focusAreas.forEach((area: string, index: number) => {
          codebaseContent += `${index + 1}. ${area}\n`;
        });
        codebaseContent += `\n---\n\n`;
      }

      codebaseContent += `# Atlas Codebase Files\n\n`;

      // Process each file pattern
      for (const pattern of filePatterns) {
        if (totalSize > maxSize) {
          codebaseContent += `\n**Note: Additional files truncated due to size limits**\n`;
          break;
        }

        try {
          const result = await this.processFilePattern(pattern, maxSize - totalSize);
          codebaseContent += result.content;
          loadedFilesCount += result.fileCount;
          totalSize += result.size;
        } catch (error) {
          console.warn(`Warning: Could not process pattern ${pattern}: ${error}`);
          codebaseContent += `## ${pattern}\n*Pattern could not be processed: ${error}*\n\n`;
        }
      }

      const processingTime = Date.now() - startTime;

      console.log(
        `Filesystem provider loaded codebase context: ${loadedFilesCount} files, ${
          this.formatSize(totalSize)
        }`,
      );

      return this.createSuccessResult(
        codebaseContent,
        undefined,
        this.createCostInfo(processingTime, totalSize),
        {
          filesLoaded: loadedFilesCount,
          totalSize,
          truncated: totalSize >= maxSize,
        },
      );
    } catch (error) {
      const processingTime = Date.now() - startTime;
      return this.createErrorResult(
        `Error loading codebase context: ${error}`,
        this.createCostInfo(processingTime),
      );
    }
  }

  // Private methods (enhanced with glob support)

  private async processFilePattern(
    pattern: string,
    remainingSize: number,
  ): Promise<{ content: string; fileCount: number; size: number }> {
    let content = "";
    let fileCount = 0;
    let size = 0;

    try {
      // Use glob expansion for pattern matching
      const basePath = this.basePath || ".";
      const fullPattern = this.basePath ? `${this.basePath}/${pattern}` : pattern;
      
      const matchedFiles: string[] = [];
      
      // Expand glob pattern
      for await (const entry of expandGlob(fullPattern, {
        root: basePath,
        includeDirs: false,
        globstar: true,
      })) {
        if (this.isAllowedFile(entry.name)) {
          matchedFiles.push(entry.path);
        }
      }

      // Sort files for consistent ordering
      matchedFiles.sort();

      // Process matched files
      for (const filePath of matchedFiles) {
        if (size >= remainingSize) {
          content += `\n**Note: Additional files truncated due to size limits**\n`;
          break;
        }

        try {
          const result = await this.processFile(filePath, this.getRelativePath(filePath));
          content += result.content;
          fileCount += result.fileCount;
          size += result.size;

          if (size >= remainingSize) break;
        } catch (error) {
          console.warn(`Warning: Could not read file ${filePath}: ${error}`);
          content += `## ${this.getRelativePath(filePath)}\n*File could not be loaded: ${error}*\n\n`;
        }
      }

      // If no files matched, try as literal file path
      if (matchedFiles.length === 0 && !this.isGlobPattern(pattern)) {
        try {
          const filePath = this.resolveFilePath(pattern);
          const result = await this.processFile(filePath, pattern);
          content = result.content;
          fileCount = result.fileCount;
          size = result.size;
        } catch (error) {
          throw new Error(`No files matched pattern '${pattern}' and literal file access failed: ${error}`);
        }
      }
    } catch (error) {
      throw new Error(`Could not process pattern '${pattern}': ${error}`);
    }

    return { content, fileCount, size };
  }

  private isGlobPattern(pattern: string): boolean {
    return /[*?[\]{}]/.test(pattern);
  }

  private getRelativePath(absolutePath: string): string {
    const basePath = this.basePath || ".";
    try {
      return relative(resolve(basePath), absolutePath);
    } catch {
      return absolutePath;
    }
  }

  private async processFile(
    filePath: string,
    originalPattern: string,
  ): Promise<{ content: string; fileCount: number; size: number }> {
    try {
      const fileContent = await Deno.readTextFile(filePath);
      const truncatedContent = fileContent.length > this.maxFileSize
        ? fileContent.slice(0, this.maxFileSize) + "\n... (truncated)"
        : fileContent;

      const content = `## ${originalPattern}\n\`\`\`typescript\n${truncatedContent}\n\`\`\`\n\n`;

      return {
        content,
        fileCount: 1,
        size: content.length,
      };
    } catch (error) {
      throw new Error(`Could not load file ${filePath}: ${error}`);
    }
  }

  private async scanDirectory(
    dirPath: string,
    resources: EMCPResource[],
    depth = 0,
  ): Promise<void> {
    if (depth > 3) return; // Limit recursion depth

    try {
      // Use glob to find all allowed files recursively
      const pattern = `${dirPath}/**/*{${this.allowedExtensions.join(',')}}`;
      
      for await (const entry of expandGlob(pattern, {
        root: dirPath,
        includeDirs: false,
        globstar: true,
      })) {
        try {
          const stat = await Deno.stat(entry.path);
          resources.push({
            uri: entry.path,
            type: "file",
            name: entry.name,
            description: `File: ${entry.name}`,
            mimeType: this.getMimeType(entry.name),
            size: stat.size,
            lastModified: stat.mtime || undefined,
          });
        } catch (_error) {
          // Skip files we can't stat
        }
      }
    } catch (_error) {
      // Skip directories we can't read
    }
  }

  private resolveFilePath(pattern: string): string {
    if (pattern.startsWith("/")) {
      return pattern; // Absolute path
    }

    if (this.basePath) {
      return `${this.basePath}/${pattern}`;
    }

    return pattern; // Relative to current directory
  }

  private isAllowedFile(filename: string): boolean {
    return this.allowedExtensions.some((ext) => filename.endsWith(ext));
  }

  private getMimeType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase();

    const mimeTypes: Record<string, string> = {
      ts: "application/typescript",
      js: "application/javascript",
      md: "text/markdown",
      json: "application/json",
      yaml: "application/yaml",
      yml: "application/yaml",
    };

    return mimeTypes[ext || ""] || "text/plain";
  }
}
