import { stat } from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fg from "fast-glob";
import { z } from "zod";
import { createSuccessResponse } from "../utils.ts";

export function registerGlobTool(server: McpServer) {
  server.registerTool(
    "fs_glob",
    {
      description: `Use this tool when you need to find files by name patterns.
        - Supports glob patterns like "**/*.js" or "src/**/*.ts"
        - Returns matching file paths sorted by modification time`,
      inputSchema: {
        pattern: z.string().describe("The glob pattern to match files against"),
        path: z
          .string()
          .optional()
          .describe(
            `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. Must be a valid directory path if provided.`,
          ),
      },
    },
    async (params) => {
      let searchPath = params.path ?? process.cwd();
      searchPath = path.isAbsolute(searchPath)
        ? searchPath
        : path.resolve(process.cwd(), searchPath);

      const limit = 100;
      const files = [];
      let truncated = false;

      // Use fast-glob
      const matches = await fg(params.pattern, {
        cwd: searchPath,
        onlyFiles: true,
        absolute: true,
        dot: true,
      });

      for (const filePath of matches) {
        if (files.length >= limit) {
          truncated = true;
          break;
        }

        let mtime = 0;
        try {
          const stats = await stat(filePath);
          mtime = stats.mtime?.getTime() ?? 0;
        } catch {
          mtime = 0;
        }

        files.push({ path: filePath, mtime: mtime });
      }

      // Sort by modification time, newest first
      files.sort((a, b) => b.mtime - a.mtime);

      const output = [];
      if (files.length === 0) {
        output.push("No files found");
      } else {
        output.push(...files.map((f) => f.path));
        if (truncated) {
          output.push("");
          output.push("(Results are truncated. Consider using a more specific path or pattern.)");
        }
      }

      return createSuccessResponse({
        title: path.relative(process.cwd(), searchPath),
        metadata: { count: files.length, truncated },
        output: output.join("\n"),
      });
    },
  );
}
