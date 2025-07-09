import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

const MAX_OUTPUT_LENGTH = 30000;
const DEFAULT_TIMEOUT = 120000; // 2 minutes
const MAX_TIMEOUT = 600000; // 10 minutes

export function registerBashTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_bash",
    {
      description:
        `Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use the atlas_list tool to verify the parent directory exists and is the correct location
   - For example, before running "mkdir foo/bar", first use atlas_list to check that "foo" exists and is the intended parent directory

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
  - The command argument is required.
  - You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 120000ms (2 minutes).
  - It is very helpful if you write a clear, concise description of what this command does in 5-10 words.
  - If the output exceeds 30000 characters, output will be truncated before being returned to you.
  - VERY IMPORTANT: You MUST avoid using search commands like \`find\` and \`grep\`. Instead use atlas_grep, atlas_glob, or other Atlas tools to search. You MUST avoid read tools like \`cat\`, \`head\`, \`tail\`, and \`ls\`, and use atlas_read and atlas_list to read files.
   - If you _still_ need to run \`grep\`, STOP. ALWAYS USE ripgrep at \`rg\` first, which all Atlas users have pre-installed.
  - When issuing multiple commands, use the ';' or '&&' operator to separate them. DO NOT use newlines (newlines are ok in quoted strings).
  - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the User explicitly requests it.
    <good-example>
    pytest /foo/bar/tests
    </good-example>
    <bad-example>
    cd /foo/bar && pytest tests
    </bad-example>`,
      inputSchema: {
        command: z.string().describe("The command to execute"),
        timeout: z.number().min(0).max(MAX_TIMEOUT).optional().describe(
          "Optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 120000ms (2 minutes).",
        ),
        description: z.string().describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: pwd\nOutput: Shows current working directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ),
      },
    },
    async (params) => {
      const timeout = Math.min(params.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);

      ctx.logger.info("Executing bash command", {
        command: params.command,
        description: params.description,
        timeout,
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const command = new Deno.Command("bash", {
          args: ["-c", params.command],
          cwd: Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
          signal: controller.signal,
        });

        const process = command.spawn();
        const { code, stdout, stderr } = await process.output();

        clearTimeout(timeoutId);

        const stdoutText = new TextDecoder().decode(stdout);
        const stderrText = new TextDecoder().decode(stderr);

        // Truncate output if it's too long
        const truncateOutput = (text: string) => {
          if (text.length > MAX_OUTPUT_LENGTH) {
            return text.substring(0, MAX_OUTPUT_LENGTH) +
              "\n\n... (output truncated due to length)";
          }
          return text;
        };

        const truncatedStdout = truncateOutput(stdoutText);
        const truncatedStderr = truncateOutput(stderrText);

        const output = [
          `<stdout>`,
          truncatedStdout ?? "",
          `</stdout>`,
          `<stderr>`,
          truncatedStderr ?? "",
          `</stderr>`,
        ].join("\n");

        ctx.logger.info("Bash command completed", {
          command: params.command,
          exitCode: code,
          stdoutLength: stdoutText.length,
          stderrLength: stderrText.length,
          truncated: stdoutText.length > MAX_OUTPUT_LENGTH || stderrText.length > MAX_OUTPUT_LENGTH,
        });

        return createSuccessResponse({
          title: params.command,
          output,
          metadata: {
            exitCode: code,
            description: params.description,
            stdout: truncatedStdout,
            stderr: truncatedStderr,
            truncated: stdoutText.length > MAX_OUTPUT_LENGTH ||
              stderrText.length > MAX_OUTPUT_LENGTH,
          },
        });
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof Error && error.name === "AbortError") {
          ctx.logger.error("Bash command timed out", {
            command: params.command,
            timeout,
          });
          throw new Error(`Command timed out after ${timeout}ms: ${params.command}`);
        }

        ctx.logger.error("Bash command failed", {
          command: params.command,
          error: error instanceof Error ? error.message : String(error),
        });

        throw error;
      }
    },
  );
}
