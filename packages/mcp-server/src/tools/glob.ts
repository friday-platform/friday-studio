import { z } from "zod/v4";
import path from "path";
import type { ToolHandler } from "./types.ts";
import { createSuccessResponse } from "./types.ts";
import DESCRIPTION from "./glob.txt" with { type: "txt" };
import { Ripgrep } from "../file/ripgrep";

const schema = z.object({
  pattern: z.string().describe("The glob pattern to match files against"),
  path: z
    .string()
    .optional()
    .describe(
      `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
    ),
});

export const globTool: ToolHandler<typeof schema> = {
  name: "glob",
  description: DESCRIPTION,
  inputSchema: schema,
  handler: async (params, { logger }) => {
    let search = params.path ?? Deno.cwd();
    search = path.isAbsolute(search) ? search : path.resolve(Deno.cwd(), search);

    const limit = 100;
    const files = [];
    let truncated = false;
    for (
      const file of await Ripgrep.files({
        cwd: search,
        glob: params.pattern,
      })
    ) {
      if (files.length >= limit) {
        truncated = true;
        break;
      }
      const full = path.resolve(search, file);
      let mtime = 0;
      try {
        const stats = await Deno.stat(full);
        mtime = stats.mtime?.getTime() ?? 0;
      } catch {
        mtime = 0;
      }
      files.push({
        path: full,
        mtime: mtime,
      });
    }
    files.sort((a, b) => b.mtime - a.mtime);

    const output = [];
    if (files.length === 0) output.push("No files found");
    if (files.length > 0) {
      output.push(...files.map((f) => f.path));
      if (truncated) {
        output.push("");
        output.push("(Results are truncated. Consider using a more specific path or pattern.)");
      }
    }

    return createSuccessResponse({
      title: path.relative(Deno.cwd(), search),
      metadata: {
        count: files.length,
        truncated,
      },
      output: output.join("\n"),
    });
  },
};
