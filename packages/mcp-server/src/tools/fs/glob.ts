import { z } from "zod";
import * as path from "@std/path";
import { expandGlob } from "@std/fs";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

export function registerGlobTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_glob",
    {
      description: `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead
- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.`,
      inputSchema: {
        pattern: z.string().describe("The glob pattern to match files against"),
        path: z
          .string()
          .optional()
          .describe(
            `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
          ),
      },
    },
    async (params) => {
      let searchPath = params.path ?? Deno.cwd();
      searchPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(Deno.cwd(), searchPath);

      const limit = 100;
      const files = [];
      let truncated = false;

      // Use expandGlob from @std/fs
      for await (
        const walkEntry of expandGlob(params.pattern, {
          root: searchPath,
          includeDirs: false, // Only files, not directories
          globstar: true,
        })
      ) {
        if (files.length >= limit) {
          truncated = true;
          break;
        }

        let mtime = 0;
        try {
          const stats = await Deno.stat(walkEntry.path);
          mtime = stats.mtime?.getTime() ?? 0;
        } catch {
          mtime = 0;
        }

        files.push({
          path: walkEntry.path,
          mtime: mtime,
        });
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
        title: path.relative(Deno.cwd(), searchPath),
        metadata: {
          count: files.length,
          truncated,
        },
        output: output.join("\n"),
      });
    },
  );
}
