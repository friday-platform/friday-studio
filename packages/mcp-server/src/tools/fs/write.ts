import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ensureDir } from "@std/fs";
import * as path from "@std/path";
import { dirname } from "@std/path";
import { z } from "zod";
import { createSuccessResponse } from "../utils.ts";

export function registerWriteTool(server: McpServer) {
  server.registerTool(
    "atlas_write",
    {
      description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path
- The file path can be absolute or relative to the current working directory
- Parent directories will be created automatically if they don't exist
- Returns information about whether the file was created or overwritten
- File size in bytes is calculated and returned in metadata
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked`,
      inputSchema: {
        filePath: z
          .string()
          .describe("The path to the file to write (can be absolute or relative)"),
        content: z.string().describe("The content to write to the file"),
      },
    },
    async (params) => {
      // Resolve file path
      const filepath = path.isAbsolute(params.filePath)
        ? params.filePath
        : path.join(Deno.cwd(), params.filePath);

      // Check if file exists
      let exists = false;
      try {
        await Deno.stat(filepath);
        exists = true;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }

      // Ensure parent directory exists
      const parentDir = dirname(filepath);
      await ensureDir(parentDir);

      // Write the file
      await Deno.writeTextFile(filepath, params.content);

      // Calculate file size
      const contentSize = new TextEncoder().encode(params.content).length;

      return createSuccessResponse({
        title: path.relative(Deno.cwd(), filepath),
        metadata: {
          filepath,
          exists,
          size_bytes: contentSize,
          action: exists ? "overwritten" : "created",
        },
        output: exists ? `File overwritten: ${filepath}` : `File created: ${filepath}`,
      });
    },
  );
}
