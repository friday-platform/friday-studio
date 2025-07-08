import { z } from "zod/v4";
import { Tool } from "./tool";
import DESCRIPTION from "./bash.txt";

const MAX_OUTPUT_LENGTH = 30000;
const DEFAULT_TIMEOUT = 1 * 60 * 1000;
const MAX_TIMEOUT = 10 * 60 * 1000;

export const BashTool = Tool.define({
  id: "bash",
  description: DESCRIPTION,
  parameters: z.object({
    command: z.string().describe("The command to execute"),
    timeout: z.number().min(0).max(MAX_TIMEOUT).describe("Optional timeout in milliseconds")
      .optional(),
    description: z
      .string()
      .describe(
        "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
      ),
  }),
  async execute(params, ctx) {
    const timeout = Math.min(params.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);

    // Create AbortController for timeout/cancellation
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Combine signals: both context abort and timeout
    if (ctx.abort) {
      ctx.abort.addEventListener("abort", () => controller.abort());
    }

    const command = new Deno.Command("bash", {
      args: ["-c", params.command],
      cwd: Deno.cwd(),
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    });

    try {
      const process = command.spawn();
      const { stdout, stderr, code } = await process.output();
      clearTimeout(timeoutId);

      // Convert Uint8Array to string
      const stdoutText = new TextDecoder().decode(stdout);
      const stderrText = new TextDecoder().decode(stderr);

      // Handle output length limit in application logic
      const truncatedStdout = stdoutText.length > MAX_OUTPUT_LENGTH
        ? stdoutText.slice(0, MAX_OUTPUT_LENGTH) + "\n... (output truncated)"
        : stdoutText;
      const truncatedStderr = stderrText.length > MAX_OUTPUT_LENGTH
        ? stderrText.slice(0, MAX_OUTPUT_LENGTH) + "\n... (output truncated)"
        : stderrText;

      return {
        title: params.command,
        metadata: {
          stderr: truncatedStderr,
          stdout: truncatedStdout,
          exit: code,
          description: params.description,
        },
        output: [
          `<stdout>`,
          truncatedStdout ?? "",
          `</stdout>`,
          `<stderr>`,
          truncatedStderr ?? "",
          `</stderr>`,
        ].join("\n"),
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        return {
          title: params.command,
          metadata: {
            stderr: "Process aborted due to timeout or cancellation",
            stdout: "",
            exit: -1,
            description: params.description,
          },
          output: `<stderr>Process aborted due to timeout or cancellation</stderr>`,
        };
      }
      throw error;
    }
  },
});
