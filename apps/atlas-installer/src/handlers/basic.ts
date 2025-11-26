import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ApiKeyCheckResult,
  ClaudePathResult,
  DirectoryResult,
  IPCHandler,
  IPCResult,
  NodePathResult,
  NpxPathResult,
  PlatformInfo,
} from "../types";
import { findClaudePath } from "../utils/claude-detector";
import { createLogger } from "../utils/logger";
import { findNodePath } from "../utils/node-detector";
import { findNpxPath } from "../utils/npx-detector";

const logger = createLogger("BasicHandlers");

// Helper for common error handling
const handleError = (err: unknown): { success: false; error: string } => ({
  success: false,
  error: err instanceof Error ? err.message : String(err),
});

/**
 * Get platform information
 */
export const getPlatformHandler: IPCHandler<[], PlatformInfo> = (): PlatformInfo => {
  return { platform: process.platform, arch: process.arch, homedir: os.homedir() };
};

/**
 * Create Atlas directory
 */
export const createAtlasDirHandler: IPCHandler<
  [],
  DirectoryResult
> = async (): Promise<DirectoryResult> => {
  try {
    const atlasDir = path.join(os.homedir(), ".atlas");
    fs.mkdirSync(atlasDir, { recursive: true });
    return { success: true, path: atlasDir };
  } catch (err) {
    return { ...handleError(err), path: undefined };
  }
};

/**
 * Check for existing API key
 */
export const checkExistingApiKeyHandler: IPCHandler<
  [],
  ApiKeyCheckResult
> = async (): Promise<ApiKeyCheckResult> => {
  try {
    const atlasDir = path.join(os.homedir(), ".atlas");
    const envFile = path.join(atlasDir, ".env");

    if (!fs.existsSync(envFile)) {
      return { exists: false };
    }

    const envContent = fs.readFileSync(envFile, "utf8");
    const hasAtlasKey =
      envContent.includes("ATLAS_KEY=") &&
      envContent.match(/ATLAS_KEY=eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);

    return { exists: !!hasAtlasKey };
  } catch (err) {
    return { exists: false, error: handleError(err).error };
  }
};

/**
 * Save NPX path to .env file
 */
export const saveAtlasNpxPathHandler: IPCHandler<
  [],
  NpxPathResult
> = async (): Promise<NpxPathResult> => {
  try {
    const atlasDir = path.join(os.homedir(), ".atlas");
    const envFile = path.join(atlasDir, ".env");

    // Ensure directory exists
    if (!fs.existsSync(atlasDir)) {
      fs.mkdirSync(atlasDir, { recursive: true });
    }

    // Find NPX path
    const npxPath = findNpxPath();
    if (!npxPath) {
      logger.warn("NPX not found on system");
      return {
        success: true,
        message: "NPX not found, skipping NPX path configuration",
      } as NpxPathResult;
    }

    logger.info(`Found NPX at: ${npxPath}`);

    // Read existing .env content or create new
    let envContent = "";
    if (fs.existsSync(envFile)) {
      envContent = fs.readFileSync(envFile, "utf8");
    }

    // Update or add ATLAS_NPX_PATH
    const npxPathLine = `ATLAS_NPX_PATH=${npxPath}`;
    if (envContent.includes("ATLAS_NPX_PATH=")) {
      envContent = envContent.replace(/ATLAS_NPX_PATH=.*$/m, npxPathLine);
    } else {
      envContent = `${envContent.trim() + (envContent ? "\n" : "") + npxPathLine}\n`;
    }

    // Write back to file
    fs.writeFileSync(envFile, envContent, "utf8");
    logger.info(`Saved NPX path to ${envFile}`);

    return { success: true, npxPath, message: `NPX path saved: ${npxPath}` };
  } catch (err) {
    logger.error("Failed to save NPX path", err);
    return { ...handleError(err), npxPath: undefined };
  }
};

/**
 * Save Node path to .env file (for bundled claude-code agent)
 */
export const saveAtlasNodePathHandler: IPCHandler<
  [],
  NodePathResult
> = async (): Promise<NodePathResult> => {
  try {
    const atlasDir = path.join(os.homedir(), ".atlas");
    const envFile = path.join(atlasDir, ".env");

    // Ensure directory exists
    if (!fs.existsSync(atlasDir)) {
      fs.mkdirSync(atlasDir, { recursive: true });
    }

    // Find Node path
    const nodePath = findNodePath();
    if (!nodePath) {
      logger.warn("Node not found on system");
      return {
        success: true,
        message: "Node not found, skipping Node path configuration",
      } as NodePathResult;
    }

    logger.info(`Found Node at: ${nodePath}`);

    // Read existing .env content or create new
    let envContent = "";
    if (fs.existsSync(envFile)) {
      envContent = fs.readFileSync(envFile, "utf8");
    }

    // Update or add ATLAS_NODE_PATH
    const nodePathLine = `ATLAS_NODE_PATH=${nodePath}`;
    if (envContent.includes("ATLAS_NODE_PATH=")) {
      envContent = envContent.replace(/ATLAS_NODE_PATH=.*$/m, nodePathLine);
    } else {
      envContent = `${envContent.trim() + (envContent ? "\n" : "") + nodePathLine}\n`;
    }

    // Write back to file
    fs.writeFileSync(envFile, envContent, "utf8");
    logger.info(`Saved Node path to ${envFile}`);

    return { success: true, nodePath, message: `Node path saved: ${nodePath}` };
  } catch (err) {
    logger.error("Failed to save Node path", err);
    return { ...handleError(err), nodePath: undefined };
  }
};

/**
 * Save Claude CLI path to .env file (for claude-code bundled agent)
 */
export const saveAtlasClaudePathHandler: IPCHandler<
  [],
  ClaudePathResult
> = async (): Promise<ClaudePathResult> => {
  try {
    const atlasDir = path.join(os.homedir(), ".atlas");
    const envFile = path.join(atlasDir, ".env");

    // Ensure directory exists
    if (!fs.existsSync(atlasDir)) {
      fs.mkdirSync(atlasDir, { recursive: true });
    }

    // Find Claude CLI path
    const claudePath = findClaudePath();
    if (!claudePath) {
      logger.warn("Claude CLI not found on system");
      return {
        success: true,
        message:
          "Claude CLI not found, skipping Claude path configuration. Install Claude Code CLI for the claude-code agent to work.",
      } as ClaudePathResult;
    }

    logger.info(`Found Claude CLI at: ${claudePath}`);

    // Read existing .env content or create new
    let envContent = "";
    if (fs.existsSync(envFile)) {
      envContent = fs.readFileSync(envFile, "utf8");
    }

    // Update or add ATLAS_CLAUDE_PATH
    const claudePathLine = `ATLAS_CLAUDE_PATH=${claudePath}`;
    if (envContent.includes("ATLAS_CLAUDE_PATH=")) {
      envContent = envContent.replace(/ATLAS_CLAUDE_PATH=.*$/m, claudePathLine);
    } else {
      envContent = `${envContent.trim() + (envContent ? "\n" : "") + claudePathLine}\n`;
    }

    // Write back to file
    fs.writeFileSync(envFile, envContent, "utf8");
    logger.info(`Saved Claude CLI path to ${envFile}`);

    return { success: true, claudePath, message: `Claude CLI path saved: ${claudePath}` };
  } catch (err) {
    logger.error("Failed to save Claude CLI path", err);
    return { ...handleError(err), claudePath: undefined };
  }
};

/**
 * Save Atlas key to .env file
 */
export const saveAtlasKeyHandler: IPCHandler<string, IPCResult> = async (
  _event,
  atlasKey,
): Promise<IPCResult> => {
  if (!atlasKey || !atlasKey.trim()) {
    return { success: false, error: "No Atlas key provided" };
  }

  try {
    const atlasDir = path.join(os.homedir(), ".atlas");
    const envFile = path.join(atlasDir, ".env");

    // Ensure directory exists
    if (!fs.existsSync(atlasDir)) {
      fs.mkdirSync(atlasDir, { recursive: true });
    }

    // Read existing .env content or create new
    let envContent = "";
    if (fs.existsSync(envFile)) {
      envContent = fs.readFileSync(envFile, "utf8");
    }

    // Update or add ATLAS_KEY
    const keyLine = `ATLAS_KEY=${atlasKey.trim()}`;
    if (envContent.includes("ATLAS_KEY=")) {
      envContent = envContent.replace(/ATLAS_KEY=.*$/m, keyLine);
    } else {
      envContent = `${envContent.trim() + (envContent ? "\n" : "") + keyLine}\n`;
    }

    // Write back to file
    fs.writeFileSync(envFile, envContent, "utf8");
    logger.info("Atlas key saved successfully");

    return { success: true, message: "Atlas key saved successfully" };
  } catch (err) {
    logger.error("Failed to save Atlas key", err);
    return handleError(err);
  }
};

/**
 * Quit the application
 */
export const quitAppHandler: IPCHandler<[], void> = (): void => {
  // Tauri handles app quit through quit_app command in Rust
  // This is a no-op in the TypeScript handlers
};
