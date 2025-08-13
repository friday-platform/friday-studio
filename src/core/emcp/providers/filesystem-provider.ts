/**
 * Filesystem EMCP Provider
 *
 * Provides access to local filesystem resources for codebase analysis
 * Migrated from SessionSupervisor.loadCodebaseContext()
 */

import { BaseEMCPProvider } from "./base-provider.ts";
import { expandGlob } from "@std/fs";
import { relative, resolve } from "@std/path";
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
  // Security controls (from official MCP filesystem server)
  readonly allowedDirectories?: string[];
  readonly deniedPaths?: string[];
  readonly readOnly?: boolean;
  readonly followSymlinks?: boolean;
}

export class FilesystemProvider extends BaseEMCPProvider {
  public readonly config: EMCPProviderConfig = {
    name: "filesystem",
    version: "1.0.0",
    description: "Local filesystem access for codebase analysis",
    capabilities: [
      {
        type: "codebase",
        operations: ["read", "list", "analyze", "write", "create", "move", "metadata"],
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
  // Security controls
  private allowedDirectories: string[] = [];
  private deniedPaths: string[] = [];
  private readOnly = false;
  private followSymlinks = false;

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

      // Security controls configuration
      if (fsConfig.allowedDirectories) {
        this.allowedDirectories = fsConfig.allowedDirectories;
      }

      if (fsConfig.deniedPaths) {
        this.deniedPaths = fsConfig.deniedPaths;
      }

      if (fsConfig.readOnly !== undefined) {
        this.readOnly = fsConfig.readOnly;
      }

      if (fsConfig.followSymlinks !== undefined) {
        this.followSymlinks = fsConfig.followSymlinks;
      }
    }

    console.log(
      `Filesystem provider initialized with base path: ${
        this.basePath || "current directory"
      }, readOnly: ${this.readOnly}`,
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
      await this.validatePath(filePath);
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

      // Use basePath from context spec if provided, otherwise use provider config
      const effectiveBasePath = codebaseSpec.basePath || this.basePath;

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
          const result = await this.processFilePattern(
            pattern,
            maxSize - totalSize,
            effectiveBasePath,
          );
          if (result.fileCount > 0) {
            codebaseContent += result.content;
            loadedFilesCount += result.fileCount;
            totalSize += result.size;
          } else {
            // Pattern matched no files - add to session report but don't warn in logs
            codebaseContent += `## ${pattern}\n*No files matched this pattern*\n\n`;
          }
        } catch (error) {
          // Add to session report but reduce console noise
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
    basePath?: string,
  ): Promise<{ content: string; fileCount: number; size: number }> {
    let content = "";
    let fileCount = 0;
    let size = 0;

    try {
      // Use glob expansion for pattern matching
      const effectiveBasePath = basePath || this.basePath || ".";
      const fullPattern = effectiveBasePath && effectiveBasePath !== "."
        ? `${effectiveBasePath}/${pattern}`
        : pattern;

      const matchedFiles: string[] = [];

      // Expand glob pattern
      for await (
        const entry of expandGlob(fullPattern, {
          root: effectiveBasePath,
          includeDirs: false,
          globstar: true,
        })
      ) {
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
          content += `## ${
            this.getRelativePath(filePath)
          }\n*File could not be loaded: ${error}*\n\n`;
        }
      }

      // If no files matched, try as literal file path
      if (matchedFiles.length === 0 && !this.isGlobPattern(pattern)) {
        try {
          const filePath = this.resolveFilePathWithBase(pattern, effectiveBasePath);
          const result = await this.processFile(filePath, pattern);
          content = result.content;
          fileCount = result.fileCount;
          size = result.size;
        } catch (error) {
          throw new Error(
            `No files matched pattern '${pattern}' and literal file access failed: ${error}`,
          );
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
      const pattern = `${dirPath}/**/*{${this.allowedExtensions.join(",")}}`;

      for await (
        const entry of expandGlob(pattern, {
          root: dirPath,
          includeDirs: false,
          globstar: true,
        })
      ) {
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
        } catch {
          // Skip files we can't stat
        }
      }
    } catch {
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

  private resolveFilePathWithBase(pattern: string, basePath: string): string {
    if (pattern.startsWith("/")) {
      return pattern; // Absolute path
    }

    if (basePath && basePath !== ".") {
      return `${basePath}/${pattern}`;
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

  // Security validation methods (from official MCP filesystem server)

  private async validatePath(filePath: string): Promise<void> {
    const resolvedPath = await Deno.realPath(filePath).catch(() => filePath);

    // Check denied paths
    for (const deniedPath of this.deniedPaths) {
      if (resolvedPath.startsWith(deniedPath)) {
        throw new Error(`Access denied: Path ${filePath} is in denied directory ${deniedPath}`);
      }
    }

    // Check allowed directories (if specified)
    if (this.allowedDirectories.length > 0) {
      const isAllowed = this.allowedDirectories.some((allowedDir) =>
        resolvedPath.startsWith(allowedDir)
      );
      if (!isAllowed) {
        throw new Error(`Access denied: Path ${filePath} is not in an allowed directory`);
      }
    }

    // Check if path traversal is attempted
    if (filePath.includes("..") && !this.followSymlinks) {
      throw new Error(`Access denied: Path traversal not allowed`);
    }
  }

  private async validateWriteOperation(filePath: string): Promise<void> {
    if (this.readOnly) {
      throw new Error(`Write operation denied: Provider is in read-only mode`);
    }
    await this.validatePath(filePath);
  }

  // Advanced editing operations (from official MCP filesystem server)

  async writeFile(uri: string, content: string, context: EMCPContext): Promise<EMCPResult> {
    this.ensureInitialized();

    const startTime = Date.now();

    try {
      const filePath = this.resolveFilePath(uri);
      await this.validateWriteOperation(filePath);

      await Deno.writeTextFile(filePath, content);
      const processingTime = Date.now() - startTime;

      return this.createSuccessResult(
        `Successfully wrote ${content.length} characters to ${uri}`,
        undefined,
        this.createCostInfo(processingTime, content.length),
        { filePath, size: content.length, operation: "write" },
      );
    } catch (error) {
      const processingTime = Date.now() - startTime;
      return this.createErrorResult(
        `Failed to write file ${uri}: ${error}`,
        this.createCostInfo(processingTime),
      );
    }
  }

  async createFile(uri: string, content: string, context: EMCPContext): Promise<EMCPResult> {
    this.ensureInitialized();

    const startTime = Date.now();

    try {
      const filePath = this.resolveFilePath(uri);
      await this.validateWriteOperation(filePath);

      // Check if file already exists
      try {
        await Deno.stat(filePath);
        throw new Error(`File ${uri} already exists`);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }

      await Deno.writeTextFile(filePath, content);
      const processingTime = Date.now() - startTime;

      return this.createSuccessResult(
        `Successfully created file ${uri} with ${content.length} characters`,
        undefined,
        this.createCostInfo(processingTime, content.length),
        { filePath, size: content.length, operation: "create" },
      );
    } catch (error) {
      const processingTime = Date.now() - startTime;
      return this.createErrorResult(
        `Failed to create file ${uri}: ${error}`,
        this.createCostInfo(processingTime),
      );
    }
  }

  async moveFile(oldUri: string, newUri: string, context: EMCPContext): Promise<EMCPResult> {
    this.ensureInitialized();

    const startTime = Date.now();

    try {
      const oldPath = this.resolveFilePath(oldUri);
      const newPath = this.resolveFilePath(newUri);

      await this.validatePath(oldPath);
      await this.validateWriteOperation(newPath);

      await Deno.rename(oldPath, newPath);
      const processingTime = Date.now() - startTime;

      return this.createSuccessResult(
        `Successfully moved ${oldUri} to ${newUri}`,
        undefined,
        this.createCostInfo(processingTime),
        { oldPath, newPath, operation: "move" },
      );
    } catch (error) {
      const processingTime = Date.now() - startTime;
      return this.createErrorResult(
        `Failed to move file from ${oldUri} to ${newUri}: ${error}`,
        this.createCostInfo(processingTime),
      );
    }
  }

  // Metadata operations (from official MCP filesystem server)

  async getFileInfo(uri: string, context: EMCPContext): Promise<EMCPResult> {
    this.ensureInitialized();

    const startTime = Date.now();

    try {
      const filePath = this.resolveFilePath(uri);
      await this.validatePath(filePath);

      const stat = await Deno.stat(filePath);
      const processingTime = Date.now() - startTime;

      const metadata = {
        path: filePath,
        name: filePath.split("/").pop() || "",
        size: stat.size,
        isFile: stat.isFile,
        isDirectory: stat.isDirectory,
        isSymlink: stat.isSymlink,
        created: stat.birthtime?.toISOString(),
        modified: stat.mtime?.toISOString(),
        accessed: stat.atime?.toISOString(),
        permissions: stat.mode,
        mimeType: stat.isFile ? this.getMimeType(filePath) : undefined,
      };

      return this.createSuccessResult(
        JSON.stringify(metadata, null, 2),
        undefined,
        this.createCostInfo(processingTime),
        { operation: "metadata", filePath, metadata },
      );
    } catch (error) {
      const processingTime = Date.now() - startTime;
      return this.createErrorResult(
        `Failed to get file info for ${uri}: ${error}`,
        this.createCostInfo(processingTime),
      );
    }
  }

  async createDirectory(uri: string, context: EMCPContext): Promise<EMCPResult> {
    this.ensureInitialized();

    const startTime = Date.now();

    try {
      const dirPath = this.resolveFilePath(uri);
      await this.validateWriteOperation(dirPath);

      await Deno.mkdir(dirPath, { recursive: true });
      const processingTime = Date.now() - startTime;

      return this.createSuccessResult(
        `Successfully created directory ${uri}`,
        undefined,
        this.createCostInfo(processingTime),
        { dirPath, operation: "create_directory" },
      );
    } catch (error) {
      const processingTime = Date.now() - startTime;
      return this.createErrorResult(
        `Failed to create directory ${uri}: ${error}`,
        this.createCostInfo(processingTime),
      );
    }
  }
}
