import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createSuccessResponse } from "../utils.ts";
import { type BashArgs, executeBash } from "./bash-handler.ts";

const MAX_TIMEOUT = 600000;

/**
 * MCP `bash` tool. Dispatches to a NATS tool worker (`tools.bash.call`) when
 * the daemon has wired one up; otherwise runs in-process via the same handler
 * the worker uses. The worker indirection is the foothold for future
 * sandboxed-execution work — when the worker moves into a container, this
 * registration doesn't change.
 */
export function registerBashTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "bash",
    {
      description: `Executes a given bash command in a persistent shell session

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use the fs_list_files tool to verify the parent directory exists and is the correct location
   - For example, before running "mkdir foo/bar", first use fs_list_files to check that "foo" exists and is the intended parent directory

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., cd "path with spaces/file.txt")
   - Examples of proper quoting:
     - cd "/Users/name/My Documents" (correct)
     - cd /Users/name/My Documents (incorrect - will fail)
     - python "/path/with spaces/script.py" (correct)
     - python /path/with spaces/script.py (incorrect - will fail)
   - After ensuring proper quoting, execute the command.
   - Capture the output of the command.

Usage notes:
  - If the output exceeds 30000 characters, output will be truncated before being returned to you.
  - VERY IMPORTANT: You MUST avoid using search commands like \`find\` and \`grep\`. Instead use fs_grep, fs_glob, or other platform tools to search. You MUST avoid read tools like \`cat\`, \`head\`, \`tail\`, and \`ls\`, and use fs_read_file and fs_list_files to read files.
  - When issuing multiple commands, use the ';' or '&&' operator to separate them. DO NOT use newlines (newlines are ok in quoted strings).
  - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the User explicitly requests it`,
      inputSchema: {
        command: z.string().describe("The command to execute"),
        timeout: z
          .number()
          .min(0)
          .max(MAX_TIMEOUT)
          .optional()
          .describe("Optional timeout in milliseconds."),
        cwd: z.string().optional().describe("Working directory for the command"),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Environment variables to merge with process env"),
      },
    },
    async (params) => {
      ctx.logger.info("Executing bash command", {
        command: params.command,
        timeout: params.timeout,
        cwd: params.cwd,
        envKeys: params.env ? Object.keys(params.env) : undefined,
        viaNats: !!ctx.toolDispatcher,
      });

      try {
        const args: BashArgs = {
          command: params.command,
          timeout: params.timeout,
          cwd: params.cwd,
          env: params.env,
        };

        const result = ctx.toolDispatcher
          ? await ctx.toolDispatcher.callTool<typeof args, ReturnType<typeof executeBash>>(
              "bash",
              args,
            )
          : await executeBash(args);

        ctx.logger.info("Bash command completed", {
          command: params.command,
          exitCode: result.metadata.exitCode,
          truncated: result.metadata.truncated,
        });

        return createSuccessResponse(result);
      } catch (error) {
        ctx.logger.error("Bash command failed", {
          command: params.command,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );
}
