import { z } from "zod/v4";
import * as path from "@std/path";
import { expandGlob } from "@std/fs";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";
import DESCRIPTION from "./glob.txt" with { type: "text" };

const schema = z.object({
  pattern: z.string().meta({ description: "The glob pattern to match files against" }),
  path: z
    .string()
    .optional()
    .meta({
      description:
        `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
    }),
});

export const globTool: ToolHandler<typeof schema> = {
  name: "glob",
  description: DESCRIPTION,
  inputSchema: schema,
  handler: async (params) => {
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
};
