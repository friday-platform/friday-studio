import { mkdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";
import { isErrnoException } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createSuccessResponse } from "../utils.ts";

export function registerWriteTool(server: McpServer) {
  server.registerTool(
    "fs_write_file",
    {
      description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path
- Relative paths resolve to the workspace working directory (~/.atlas/workspaces/<workspaceId>/)
  when invoked from a workspace context; absolute paths are honored as-is
- Parent directories will be created automatically if they don't exist
- Returns information about whether the file was created or overwritten
- File size in bytes is calculated and returned in metadata
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked`,
      inputSchema: {
        filePath: z
          .string()
          .describe(
            "The path to the file to write. Relative paths resolve to the workspace " +
              "working directory; absolute paths are honored as-is.",
          ),
        content: z.string().describe("The content to write to the file"),
        // N5 (melodic-strolling-seal-pt3): scope-injected by
        // `wrapPlatformToolsWithScope` from the FSM/orchestrator runtime.
        // Authors do NOT pass this; the runtime overwrites any
        // caller-supplied value (defense-in-depth). When absent (CLI
        // invocations, ad-hoc test calls) we fall back to `process.cwd()`
        // matching the pre-N5 behavior.
        workspaceId: z
          .string()
          .optional()
          .describe(
            "Runtime-injected. The workspace this call belongs to; the tool resolves " +
              "relative paths against `<friday-home>/workspaces/<workspaceId>/`.",
          ),
      },
    },
    async (params) => {
      // N5 — relative path base = workspace working directory when we
      // have a workspaceId, else the daemon's cwd. Absolute paths bypass
      // this entirely.
      const baseDir = params.workspaceId
        ? path.join(getFridayHome(), "workspaces", params.workspaceId)
        : process.cwd();
      const filepath = path.isAbsolute(params.filePath)
        ? params.filePath
        : path.join(baseDir, params.filePath);

      // Check if file exists
      let exists = false;
      try {
        await stat(filepath);
        exists = true;
      } catch (error) {
        if (!(isErrnoException(error) && error.code === "ENOENT")) {
          throw error;
        }
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(filepath);
      await mkdir(parentDir, { recursive: true });

      // Write the file
      await writeFile(filepath, params.content, "utf-8");

      // Calculate file size
      const contentSize = new TextEncoder().encode(params.content).length;

      return createSuccessResponse({
        title: path.relative(process.cwd(), filepath),
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
