import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    const cmd = new Deno.Command(command, { args: ["--version"], stdout: "null", stderr: "null" });
    const { code } = await cmd.output();
    return code === 0;
  } catch {
    return false;
  }
}

async function runRipgrep(
  pattern: string,
  searchPath: string,
  include?: string,
): Promise<{ stdout: Uint8Array; stderr: Uint8Array; code: number }> {
  const args = ["-n", pattern];
  if (include) {
    args.push("--glob", include);
  }
  args.push(searchPath);

  const command = new Deno.Command("rg", { args: args, stdout: "piped", stderr: "piped" });

  return await command.output();
}

async function runGrep(
  pattern: string,
  searchPath: string,
  include?: string,
): Promise<{ stdout: Uint8Array; stderr: Uint8Array; code: number }> {
  // For system grep, we'll use find + grep for better compatibility
  if (include) {
    // Use find to filter files, then grep them
    const findArgs = [
      searchPath,
      "-type",
      "f",
      "-name",
      include,
      "-exec",
      "grep",
      "-Hn",
      pattern,
      "{}",
      "+",
    ];
    const command = new Deno.Command("find", { args: findArgs, stdout: "piped", stderr: "piped" });
    return await command.output();
  } else {
    // Simple recursive grep
    const args = ["-rn", pattern, searchPath];
    const command = new Deno.Command("grep", { args: args, stdout: "piped", stderr: "piped" });
    return await command.output();
  }
}

export function registerGrepTool(server: McpServer, _ctx: ToolContext) {
  server.registerTool(
    "atlas_grep",
    {
      description: `- Fast content search tool that works with any codebase size
- Searches file contents using regular expressions
- Supports full regex syntax (eg. "log.*Error", "function\\s+\\w+", etc.)
- Filter files by pattern with the include parameter (eg. "*.js", "*.{ts,tsx}")
- Returns file paths with at least one match sorted by modification time
- Use this tool when you need to find files containing specific patterns
- Automatically uses ripgrep (rg) if available, otherwise falls back to system grep
- If you need to identify/count the number of matches within files, use the Bash tool with \`rg\` (ripgrep) if available
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead`,
      inputSchema: {
        pattern: z.string().describe("The regex pattern to search for in file contents"),
        path: z
          .string()
          .optional()
          .describe("The directory to search in. Defaults to the current working directory."),
        include: z
          .string()
          .optional()
          .describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
      },
    },
    async (params) => {
      if (!params.pattern) {
        throw new Error("pattern is required");
      }

      const searchPath = params.path || Deno.cwd();

      // Check if ripgrep is available
      const hasRipgrep = await isCommandAvailable("rg");

      let result;
      if (hasRipgrep) {
        result = await runRipgrep(params.pattern, searchPath, params.include);
      } else {
        result = await runGrep(params.pattern, searchPath, params.include);
      }

      const { stdout, stderr, code: exitCode } = result;
      const output = new TextDecoder().decode(stdout);
      const errorOutput = new TextDecoder().decode(stderr);

      // Exit code 1 typically means no matches found
      if (exitCode === 1) {
        return createSuccessResponse({
          title: params.pattern,
          metadata: { matches: 0, truncated: false },
          output: "No files found",
        });
      }

      if (exitCode !== 0) {
        throw new Error(`Search failed: ${errorOutput}`);
      }

      const lines = output.trim().split("\n");
      const matches = [];

      for (const line of lines) {
        if (!line) continue;

        // Both rg and grep output format: filename:linenum:content
        const parts = line.split(":", 3);
        if (parts.length < 3) continue;

        const filePath = parts[0];
        const lineNum = parseInt(parts[1], 10);
        const lineText = parts[2];

        if (!filePath) continue;

        let modTime = 0;
        try {
          const stats = await Deno.stat(filePath);
          modTime = stats.mtime?.getTime() ?? 0;
        } catch {
          continue;
        }

        matches.push({ path: filePath, modTime: modTime, lineNum, lineText });
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
        outputLines.push(
          "(Results are truncated. Consider using a more specific path or pattern.)",
        );
      }

      return createSuccessResponse({
        title: params.pattern,
        metadata: { matches: finalMatches.length, truncated },
        output: outputLines.join("\n"),
      });
    },
  );
}
