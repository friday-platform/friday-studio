import { z } from "zod/v4";
import type { ToolHandler } from "./types.ts";
import { createSuccessResponse } from "./types.ts";
import { Ripgrep } from "../file/ripgrep";

import DESCRIPTION from "./grep.txt" with { type: "txt" };

const schema = z.object({
  pattern: z.string().describe("The regex pattern to search for in file contents"),
  path: z.string().optional().describe(
    "The directory to search in. Defaults to the current working directory.",
  ),
  include: z.string().optional().describe(
    'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  ),
});

export const grepTool: ToolHandler<typeof schema> = {
  name: "grep",
  description: DESCRIPTION,
  inputSchema: schema,
  handler: async (params, { logger }) => {
    if (!params.pattern) {
      throw new Error("pattern is required");
    }

    const searchPath = params.path || Deno.cwd();

    const rgPath = await Ripgrep.filepath();
    const args = ["-n", params.pattern];
    if (params.include) {
      args.push("--glob", params.include);
    }
    args.push(searchPath);

    const command = new Deno.Command(rgPath, {
      args: args,
      stdout: "piped",
      stderr: "piped",
    });

    const { stdout, stderr, code: exitCode } = await command.output();
    const output = new TextDecoder().decode(stdout);
    const errorOutput = new TextDecoder().decode(stderr);

    if (exitCode === 1) {
      return createSuccessResponse({
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      });
    }

    if (exitCode !== 0) {
      throw new Error(`ripgrep failed: ${errorOutput}`);
    }

    const lines = output.trim().split("\n");
    const matches = [];

    for (const line of lines) {
      if (!line) continue;

      const parts = line.split(":", 3);
      if (parts.length < 3) continue;

      const filePath = parts[0];
      const lineNum = parseInt(parts[1], 10);
      const lineText = parts[2];

      let modTime = 0;
      try {
        const stats = await Deno.stat(filePath);
        modTime = stats.mtime?.getTime() ?? 0;
      } catch {
        continue;
      }

      matches.push({
        path: filePath,
        modTime: modTime,
        lineNum,
        lineText,
      });
    }

    matches.sort((a, b) => b.modTime - a.modTime);

    const limit = 100;
    const truncated = matches.length > limit;
    const finalMatches = truncated ? matches.slice(0, limit) : matches;

    if (finalMatches.length === 0) {
      return createSuccessResponse({
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      });
    }

    const outputLines = [`Found ${finalMatches.length} matches`];

    let currentFile = "";
    for (const match of finalMatches) {
      if (currentFile !== match.path) {
        if (currentFile !== "") {
          outputLines.push("");
        }
        currentFile = match.path;
        outputLines.push(`${match.path}:`);
      }
      outputLines.push(`  Line ${match.lineNum}: ${match.lineText}`);
    }

    if (truncated) {
      outputLines.push("");
      outputLines.push("(Results are truncated. Consider using a more specific path or pattern.)");
    }

    return createSuccessResponse({
      title: params.pattern,
      metadata: {
        matches: finalMatches.length,
        truncated,
      },
      output: outputLines.join("\n"),
    });
  },
};
