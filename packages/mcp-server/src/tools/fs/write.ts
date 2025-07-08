import { z } from "zod/v4";
import * as path from "@std/path";
import { dirname } from "@std/path";
import { ensureDir } from "@std/fs";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";
import DESCRIPTION from "./write.txt" with { type: "text" };

const schema = z.object({
  filePath: z.string().describe(
    "The path to the file to write (can be absolute or relative)",
  ),
  content: z.string().describe("The content to write to the file"),
});

export const writeTool: ToolHandler<typeof schema> = {
  name: "write",
  description: DESCRIPTION,
  inputSchema: schema,
  handler: async (params, { logger: _logger }) => {
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
};
