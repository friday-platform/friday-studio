/**
 * Atlas Filesystem Tools - AI SDK Compatible
 */

import { z } from "zod";
import { tool } from "ai";
import { getErrorMessage } from "./utils.ts";

/**
 * Filesystem Tools
 *
 * Tools for file and directory operations
 */
export const filesystemTools = {
  atlas_read: tool({
    description:
      "Reads files with support for images, screenshots, pagination and line limits. Handles temporary file paths. Provides line numbering and truncation for large files. Use for batch reading multiple files efficiently.",
    parameters: z.object({
      filePath: z.string().describe("The absolute path to the file to read"),
      offset: z.number().optional().describe("The line number to start reading from (0-based)"),
      limit: z.number().optional().describe("The number of lines to read (defaults to 2000)"),
    }),
    execute: async ({ filePath, offset, limit }) => {
      try {
        const stats = await Deno.stat(filePath);
        const MAX_READ_SIZE = 250 * 1024;

        if (stats.size > MAX_READ_SIZE) {
          throw new Error(
            `File is too large (${stats.size} bytes). Maximum size is ${MAX_READ_SIZE} bytes`,
          );
        }

        const content = await Deno.readTextFile(filePath);
        const lines = content.split("\n");
        const startLine = offset || 0;
        const endLine = startLine + (limit || 2000);

        const selectedLines = lines.slice(startLine, endLine);
        const numberedLines = selectedLines.map((line, index) =>
          `${(index + startLine + 1).toString().padStart(5, "0")}| ${line}`
        );

        return {
          filePath,
          content: numberedLines.join("\n"),
          totalLines: lines.length,
          displayedLines: selectedLines.length,
          hasMore: lines.length > endLine,
        };
      } catch (error) {
        throw new Error(`Failed to read file: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_write: tool({
    description:
      "Writes content to files with automatic directory creation. Will overwrite existing files. Prefer editing existing files over creating new ones. Avoid creating documentation files unless explicitly requested.",
    parameters: z.object({
      filePath: z.string().describe("The absolute path to the file to write"),
      content: z.string().describe("The content to write to the file"),
    }),
    execute: async ({ filePath, content }) => {
      try {
        const dir = filePath.split("/").slice(0, -1).join("/");
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(filePath, content);

        const stats = await Deno.stat(filePath);
        return {
          filePath,
          bytesWritten: stats.size,
          success: true,
        };
      } catch (error) {
        throw new Error(`Failed to write file: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_list: tool({
    description:
      "Lists directory contents with optional glob pattern filtering and ignore patterns.",
    parameters: z.object({
      path: z.string().optional().describe(
        "Directory path to list (defaults to current directory)",
      ),
      ignore: z.array(z.string()).optional().describe(
        'Glob patterns to ignore (e.g., ["node_modules", "*.log"])',
      ),
    }),
    execute: async ({ path = Deno.cwd(), ignore = [] }) => {
      try {
        const entries = [];
        const defaultIgnore = [".git", "node_modules", ".DS_Store", "*.log"];
        const allIgnore = [...defaultIgnore, ...ignore];

        for await (const entry of Deno.readDir(path)) {
          const shouldIgnore = allIgnore.some((pattern) =>
            entry.name.includes(pattern.replace("*", ""))
          );

          if (!shouldIgnore) {
            const fullPath = `${path}/${entry.name}`;
            const stats = await Deno.stat(fullPath);
            entries.push({
              name: entry.name,
              path: fullPath,
              isDirectory: entry.isDirectory,
              isFile: entry.isFile,
              size: stats.size,
              modified: stats.mtime?.toISOString(),
            });
          }
        }

        return {
          path,
          entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
          count: entries.length,
        };
      } catch (error) {
        throw new Error(`Failed to list directory: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_glob: tool({
    description:
      "Fast file pattern matching with glob syntax support, sorted by modification time.",
    parameters: z.object({
      pattern: z.string().describe(
        'The glob pattern to match files against (e.g., "**/*.ts", "src/**/*.js")',
      ),
      path: z.string().optional().describe(
        "Directory to search in (defaults to current directory)",
      ),
    }),
    execute: async ({ pattern, path = Deno.cwd() }) => {
      try {
        const { expandGlob } = await import("https://deno.land/std@0.208.0/fs/expand_glob.ts");
        const matches = [];

        for await (const file of expandGlob(pattern, { root: path })) {
          matches.push({
            path: file.path,
            name: file.name,
            isDirectory: file.isDirectory,
            isFile: file.isFile,
          });
        }

        return {
          pattern,
          searchPath: path,
          matches: matches.slice(0, 100), // Limit to 100 files
          count: matches.length,
        };
      } catch (error) {
        throw new Error(`Failed to glob files: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_grep: tool({
    description:
      "Powerful content search with full regex syntax. Uses ripgrep for performance. Supports file filtering with glob patterns. Use for open-ended searches requiring multiple rounds.",
    parameters: z.object({
      pattern: z.string().describe("The regex pattern to search for"),
      path: z.string().optional().describe(
        "File or directory to search in (defaults to current directory)",
      ),
      include: z.string().optional().describe("Include only files matching this pattern"),
    }),
    execute: async ({ pattern, path = Deno.cwd(), include }) => {
      try {
        const args = [pattern];
        if (path) args.push(path);
        if (include) args.push("--include", include);

        // Try ripgrep first
        let command = new Deno.Command("rg", {
          args: [...args, "--line-number", "--no-heading"],
          stdout: "piped",
          stderr: "piped",
        });

        try {
          const { stdout, success } = await command.output();
          if (success) {
            const output = new TextDecoder().decode(stdout);
            const lines = output.trim().split("\n").filter((line) => line.length > 0);
            return {
              pattern,
              searchPath: path,
              matches: lines.map((line) => {
                const parts = line.split(":", 3);
                const filePath = parts[0] || "";
                const lineNumber = parseInt(parts[1] || "0");
                const content = parts[2] || "";
                return { filePath, lineNumber, content };
              }),
              count: lines.length,
              tool: "ripgrep",
            };
          }
        } catch {
          // Fall back to system grep
          command = new Deno.Command("grep", {
            args: ["-r", "-n", pattern, path],
            stdout: "piped",
            stderr: "piped",
          });

          const { stdout, success } = await command.output();
          if (success) {
            const output = new TextDecoder().decode(stdout);
            const lines = output.trim().split("\n").filter((line) => line.length > 0);
            return {
              pattern,
              searchPath: path,
              matches: lines.map((line) => {
                const parts = line.split(":", 3);
                const filePath = parts[0] || "";
                const lineNumber = parseInt(parts[1] || "0");
                const content = parts[2] || "";
                return { filePath, lineNumber, content };
              }),
              count: lines.length,
              tool: "grep",
            };
          }
        }

        return {
          pattern,
          searchPath: path,
          matches: [],
          count: 0,
          tool: "none",
        };
      } catch (error) {
        throw new Error(`Failed to search: ${getErrorMessage(error)}`);
      }
    },
  }),
};
