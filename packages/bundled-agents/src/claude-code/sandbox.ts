import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "@atlas/logger";

const logger = createLogger({ module: "claude-code:sandbox" });

export interface SandboxContext {
  workDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Create ephemeral sandbox directory for agent execution.
 * Directory is created in system temp with session-specific prefix.
 * @param sessionId - Session ID (always available from AgentContext)
 */
export async function createSandbox(sessionId: string): Promise<SandboxContext> {
  const prefix = join(tmpdir(), `atlas-claude-${sessionId}-`);
  const workDir = await mkdtemp(prefix);
  logger.debug("Created sandbox", { workDir, sessionId });

  return {
    workDir,
    cleanup: async () => {
      try {
        await rm(workDir, { recursive: true, force: true });
        logger.debug("Cleaned sandbox", { workDir });
      } catch (error) {
        // Log but don't throw - cleanup failure shouldn't fail the agent
        logger.warn("Sandbox cleanup failed", { workDir, error });
      }
    },
  };
}

/**
 * SDK sandbox options for restricting file/network access.
 */
export const sandboxOptions: SandboxSettings = { enabled: true, autoAllowBashIfSandboxed: true };
