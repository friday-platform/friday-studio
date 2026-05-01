import * as path from "node:path";
import process from "node:process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fg from "fast-glob";
import { minimatch } from "minimatch";
import { z } from "zod";
import { createSuccessResponse } from "../utils.ts";

const IGNORE_PATTERNS = ["node_modules/", ".git/", "dist/", "build/"];

const LIMIT = 100;

export function registerLsTool(server: McpServer) {
  server.registerTool(
    "fs_list_files",
    {
      description:
        "Lists files and directories in a given path. The path parameter can be either absolute or relative. You can optionally provide an array of glob patterns to ignore with the ignore parameter. You should generally prefer the Glob and Grep tools, if you know which directories to search.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("The path to the directory to list (can be absolute or relative)"),
        ignore: z.array(z.string()).optional().describe("List of glob patterns to ignore"),
      },
    },
    async (params) => {
      const searchPath = path.resolve(process.cwd(), params.path || ".");

      const files = [];

      // Directory scanning with glob pattern
      const matches = await fg("**/*", {
        cwd: searchPath,
        onlyFiles: false,
        absolute: false,
        dot: true,
      });

      for (const file of matches) {
        if (IGNORE_PATTERNS.some((p) => file.includes(p))) continue;

        // Check against ignore patterns using minimatch
        if (params.ignore?.some((pattern) => minimatch(file, pattern))) continue;

        files.push(file);
        if (files.length >= LIMIT) break;
      }

      // Build directory structure
      const dirs = new Set<string>();
      const filesByDir = new Map<string, string[]>();

      for (const file of files) {
        const dir = path.dirname(file);
        const parts = dir === "." ? [] : dir.split("/");

        // Add all parent directories
        for (let i = 0; i <= parts.length; i++) {
          const dirPath = i === 0 ? "." : parts.slice(0, i).join("/");
          dirs.add(dirPath);
        }

        // Add file to its directory
        if (!filesByDir.has(dir)) filesByDir.set(dir, []);
        filesByDir.get(dir)?.push(path.basename(file));
      }

      function renderDir(dirPath: string, depth: number): string {
        const indent = "  ".repeat(depth);
        let output = "";

        if (depth > 0) {
          output += `${indent}${path.basename(dirPath)}/\n`;
        }

        const childIndent = "  ".repeat(depth + 1);
        const children = Array.from(dirs)
          .filter((d) => path.dirname(d) === dirPath && d !== dirPath)
          .sort();

        // Render subdirectories first
        for (const child of children) {
          output += renderDir(child, depth + 1);
        }

        // Render files
        const files = filesByDir.get(dirPath) || [];
        for (const file of files.sort()) {
          output += `${childIndent}${file}\n`;
        }

        return output;
      }

      const output = `${searchPath}/\n${renderDir(".", 0)}`;

      return createSuccessResponse({
        title: path.relative(process.cwd(), searchPath),
        metadata: { count: files.length, truncated: files.length >= LIMIT },
        output,
      });
    },
  );
}
