import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import type { StreamEmitter } from "@atlas/agent-sdk";
import { tool } from "ai";
import { z } from "zod";

import { formatExecError, parseCommandArgs } from "./agent-browser-utils.ts";

const execFileAsync = promisify(execFile);

const FIRST_CALL_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;

const AUTO_CONNECT = process.env.AGENT_BROWSER_AUTO_CONNECT === "1";

export interface SessionState {
  sessionName: string;
  daemonStarted: boolean;
}

/**
 * Creates the browse AI SDK tool for agent-browser CLI automation.
 *
 * The agent-browser daemon auto-spawns on the first command, so no explicit
 * start step is needed. When `AGENT_BROWSER_AUTO_CONNECT=1` is set, the
 * `--session` flag is omitted and the command attaches to the user's
 * already-running Chrome — sessions do not isolate in that mode.
 *
 * @param stream - Stream emitter for progress events
 * @param sessionState - Mutable session state shared with the handler for cleanup
 * @param abortSignal - Optional abort signal for cancellation
 */
export function createBrowseTool(
  stream: StreamEmitter | undefined,
  sessionState: SessionState,
  abortSignal?: AbortSignal,
) {
  return tool({
    description:
      "Execute an agent-browser command. Runs `agent-browser [--session <name>] <command>` " +
      "under the hood — just provide the command part (e.g. 'open https://example.com', " +
      "'snapshot -i', 'click @e3'). Session is managed automatically.",
    inputSchema: z.object({
      command: z
        .string()
        .describe("Browser command (e.g. 'open https://example.com', 'snapshot -i', 'click @e3')"),
    }),
    execute: async ({ command }): Promise<string> => {
      const sessionArgs = AUTO_CONNECT ? [] : ["--session", sessionState.sessionName];
      const timeout = sessionState.daemonStarted ? COMMAND_TIMEOUT_MS : FIRST_CALL_TIMEOUT_MS;

      try {
        const { stdout, stderr } = await execFileAsync(
          "agent-browser",
          [...sessionArgs, ...parseCommandArgs(command)],
          { timeout, signal: abortSignal },
        );

        if (!sessionState.daemonStarted) {
          sessionState.daemonStarted = true;
          stream?.emit({
            type: "data-tool-progress",
            data: { toolName: "Web", content: "Starting browser..." },
          });
        }

        if (stdout.trim()) {
          return stdout;
        }
        return stderr || "(no output)";
      } catch (error: unknown) {
        return `Error: ${formatExecError(error)}`;
      }
    },
  });
}

/**
 * Stops the agent-browser daemon session if one was started.
 * No-op when the daemon never started or when `AGENT_BROWSER_AUTO_CONNECT=1`
 * (we must never close the user's real Chrome). Intended for use in the
 * handler's `finally` block.
 */
export async function stopSession(sessionState: SessionState): Promise<void> {
  if (!sessionState.daemonStarted || AUTO_CONNECT) {
    return;
  }

  sessionState.daemonStarted = false;

  try {
    await execFileAsync("agent-browser", ["--session", sessionState.sessionName, "close"], {
      timeout: CLOSE_TIMEOUT_MS,
    });
  } catch {
    // Best-effort cleanup — daemon self-expires on idle
  }
}
