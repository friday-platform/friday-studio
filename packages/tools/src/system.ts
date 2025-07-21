/**
 * Atlas System Tools - AI SDK Compatible
 */

import { z } from "zod";
import { tool } from "ai";
import {
  defaultContext,
  fetchWithTimeout,
  getErrorMessage,
  handleDaemonResponse,
} from "./utils.ts";

/**
 * System and Web Tools
 *
 * Tools for system operations, web fetching, and notifications
 */
export const systemTools = {
  atlas_fetch: tool({
    description: "Fetches web content with Playwright support and format conversion.",
    parameters: z.object({
      url: z.string().url().describe("The URL to fetch content from"),
      format: z.enum(["text", "markdown", "html"]).describe("Format for the returned content"),
      timeout: z.number().optional().describe("Request timeout in milliseconds"),
    }),
    execute: async ({ url, format, timeout = 30000 }) => {
      try {
        const response = await fetchWithTimeout(url, { timeout });
        let content = await response.text();

        if (format === "markdown" && response.headers.get("content-type")?.includes("text/html")) {
          // Simple HTML to Markdown conversion
          content = content
            .replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n")
            .replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n")
            .replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n")
            .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
            .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
            .replace(/<[^>]*>/g, "")
            .trim();
        }

        return {
          url,
          format,
          content,
          contentType: response.headers.get("content-type"),
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        };
      } catch (error) {
        throw new Error(`Failed to fetch URL: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_bash: tool({
    description:
      "Executes bash commands with timeout and output handling. Use proper path quoting for spaces. Prefer Atlas tools (grep, glob) over system commands. Avoid interactive commands.",
    parameters: z.object({
      command: z.string().describe("The bash command to execute"),
      timeout: z.number().optional().describe("Command timeout in milliseconds (max 600000)"),
      description: z.string().describe("Clear description of what this command does"),
    }),
    execute: async ({ command, timeout = 120000, description }) => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), Math.min(timeout, 600000));

        const cmd = new Deno.Command("bash", {
          args: ["-c", command],
          stdout: "piped",
          stderr: "piped",
          signal: controller.signal,
        });

        const process = cmd.spawn();
        const { code, stdout, stderr } = await process.output();

        clearTimeout(timeoutId);

        const stdoutText = new TextDecoder().decode(stdout);
        const stderrText = new TextDecoder().decode(stderr);

        // Truncate output if too long
        const MAX_OUTPUT = 30000;
        const truncatedStdout = stdoutText.length > MAX_OUTPUT
          ? stdoutText.substring(0, MAX_OUTPUT) + "\n... (output truncated)"
          : stdoutText;
        const truncatedStderr = stderrText.length > MAX_OUTPUT
          ? stderrText.substring(0, MAX_OUTPUT) + "\n... (output truncated)"
          : stderrText;

        return {
          command,
          description,
          exitCode: code,
          stdout: truncatedStdout,
          stderr: truncatedStderr,
          success: code === 0,
          truncated: stdoutText.length > MAX_OUTPUT || stderrText.length > MAX_OUTPUT,
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`Command timed out after ${timeout}ms: ${command}`);
        }
        throw new Error(`Failed to execute command: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_notify_email: tool({
    description:
      "Send email notifications via SendGrid with template support, attachments, and automatic retry with exponential backoff.",
    parameters: z.object({
      to: z.string().email().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      content: z.string().describe("Email content/body"),
      from: z.string().email().optional().describe("Sender email address"),
      from_name: z.string().optional().describe("Sender name"),
      template_id: z.string().optional().describe("SendGrid template ID"),
      template_data: z.record(z.string(), z.unknown()).optional().describe(
        "Data for template substitution",
      ),
      attachments: z.array(z.object({
        filename: z.string(),
        content: z.string(),
        type: z.string(),
      })).optional().describe("Email attachments"),
    }),
    execute: async (
      { to, subject, content, from, from_name, template_id, template_data, attachments },
    ) => {
      try {
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/notifications/email`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              to,
              subject,
              content,
              from,
              from_name,
              template_id,
              template_data,
              attachments,
            }),
          },
        );
        const result = await handleDaemonResponse(response);
        return { result };
      } catch (error) {
        throw new Error(`Failed to send email: ${getErrorMessage(error)}`);
      }
    },
  }),
};
