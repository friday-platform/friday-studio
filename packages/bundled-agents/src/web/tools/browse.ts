import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StreamEmitter } from "@atlas/agent-sdk";
import { tool } from "ai";
import { z } from "zod";

import { formatExecError, parseCommandArgs } from "./agent-browser-utils.ts";

const execFileAsync = promisify(execFile);

const COMMAND_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 10_000;

export interface SessionState {
  sessionId: string | null;
}

/**
 * Starts a Steel browser session if one isn't already running.
 * Returns the session ID or an error string.
 */
async function ensureSession(
  sessionState: SessionState,
  stream: StreamEmitter | undefined,
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  if (sessionState.sessionId) {
    return { ok: true, sessionId: sessionState.sessionId };
  }

  stream?.emit({
    type: "data-tool-progress",
    data: { toolName: "Web", content: "Starting browser session..." },
  });

  try {
    const { stdout } = await execFileAsync("steel", ["browser", "start"], {
      timeout: SESSION_TIMEOUT_MS,
    });
    const sessionId = stdout.trim();
    sessionState.sessionId = sessionId;
    return { ok: true, sessionId };
  } catch (error: unknown) {
    return { ok: false, error: `Failed to start browser session: ${formatExecError(error)}` };
  }
}

/**
 * Creates the browse AI SDK tool for Steel CLI browser automation.
 * Session initialization is lazy — the Steel session starts on the first call.
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
      "Execute a steel browser command. Runs `steel browser <command> --session <id>` " +
      "under the hood — just provide the command part (e.g. 'open https://example.com', " +
      "'snapshot -i', 'click @e3'). Session is managed automatically.",
    inputSchema: z.object({
      command: z
        .string()
        .describe("Browser command (e.g. 'open https://example.com', 'snapshot -i', 'click @e3')"),
    }),
    execute: async ({ command }): Promise<string> => {
      const session = await ensureSession(sessionState, stream);
      if (!session.ok) {
        return session.error;
      }

      const args = parseCommandArgs(command);

      try {
        const { stdout, stderr } = await execFileAsync(
          "steel",
          ["browser", ...args, "--session", session.sessionId],
          { timeout: COMMAND_TIMEOUT_MS, signal: abortSignal },
        );

        if (stdout.trim()) {
          return stdout;
        }
        return stderr || "(no output)";
      } catch (error: unknown) {
        const message = formatExecError(error);
        return `Error: ${message}`;
      }
    },
  });
}

/**
 * Stops the Steel browser session if one is active.
 * Resets sessionState.sessionId to null regardless of outcome.
 * Intended for use in the handler's `finally` block.
 */
export async function stopSession(sessionState: SessionState): Promise<void> {
  if (!sessionState.sessionId) {
    return;
  }

  const sessionId = sessionState.sessionId;
  sessionState.sessionId = null;

  try {
    await execFileAsync("steel", ["browser", "stop", "--session", sessionId], {
      timeout: SESSION_TIMEOUT_MS,
    });
  } catch {
    // Best-effort cleanup — session will expire on its own
  }
}
