import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { client, parseResult } from "@atlas/client/v2";
import { extractTempestUserId, fetchCredentials, setToEnv } from "@atlas/core/credentials";
import { logger } from "@atlas/logger";
import { exists } from "@atlas/utils/fs.server";
import { getFridayHome } from "@atlas/utils/paths.server";
import { makeTempDir } from "@atlas/utils/temp.server";
import { load, parse } from "@std/dotenv";
import { fetchCypherToken } from "../../services/cypher-token.ts";
import { ensureLocalFridayKey } from "../../services/local-friday-key.ts";
import { displayDaemonStatus } from "../../utils/daemon-status.ts";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import type { YargsInstance } from "../../utils/yargs.ts";

// OTEL Configuration Strategy:
// - OTEL must be configured via env vars BEFORE Deno starts (Deno bug #27851, fixed in PR #29240)
// - Kubernetes: OTEL vars set in pod spec
// - Desktop: Auto-configured via re-exec when FRIDAY_KEY is present
const OTEL_ENDPOINT = "https://otel.hellofriday.ai";

// Shared deno run flags - single source of truth
const DENO_RUN_FLAGS = [
  "--allow-all",
  "--unstable-kv",
  "--unstable-broadcast-channel",
  "--unstable-worker-options",
  "--unstable-raw-imports",
] as const;

/**
 * Check if running via `deno run` vs compiled binary.
 * More robust than checking binary name - if execPath is deno, we're interpreted.
 */
function isRunningViaDeno(): boolean {
  const execPath = Deno.execPath();
  return execPath.endsWith("deno") || execPath.endsWith("deno.exe");
}

/**
 * Build args array for `deno run` command.
 */
function buildDenoRunArgs(scriptPath: string, scriptArgs: string[]): string[] {
  return ["run", ...DENO_RUN_FLAGS, scriptPath, ...scriptArgs];
}

/**
 * Build command args, handling deno run vs compiled binary.
 */
function buildCommandArgs(scriptArgs: string[]): string[] {
  if (isRunningViaDeno()) {
    const scriptPath = Deno.mainModule.replace("file://", "");
    return buildDenoRunArgs(scriptPath, scriptArgs);
  }
  return scriptArgs;
}

/**
 * Build daemon start args from StartArgs.
 */
function buildDaemonArgs(argv: StartArgs): string[] {
  return [
    "daemon",
    "start",
    "--port",
    (argv.port || 8080).toString(),
    "--hostname",
    argv.hostname || "127.0.0.1",
    "--max-workspaces",
    (argv.maxWorkspaces || 10).toString(),
    "--idle-timeout",
    (argv.idleTimeout || 300).toString(),
    ...(argv.logLevel ? ["--log-level", argv.logLevel] : []),
    ...(argv.atlasConfig ? ["--atlas-config", argv.atlasConfig] : []),
  ];
}

/**
 * Build OTEL environment variables from FRIDAY_KEY.
 * The Authorization header must be URL-encoded (space becomes %20).
 * Resource attributes are added for telemetry identification.
 */
function buildOtelEnv(atlasKey: string): Record<string, string> {
  const tempestUserId = extractTempestUserId(atlasKey);

  // Build resource attributes for telemetry identification
  const resourceAttrs: string[] = [];

  // Add hostname (standard OTEL semantic convention)
  try {
    resourceAttrs.push(`host.name=${Deno.hostname()}`);
  } catch {
    // hostname() may fail in sandboxed environments
  }

  // Add tempest user ID if available
  if (tempestUserId) {
    resourceAttrs.push(`tempest.user_id=${tempestUserId}`);
  }

  const env: Record<string, string> = {
    OTEL_DENO: "true",
    OTEL_SERVICE_NAME: "atlas",
    OTEL_EXPORTER_OTLP_ENDPOINT: OTEL_ENDPOINT,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer%20${atlasKey}`,
    OTEL_BLRP_SCHEDULE_DELAY: "5000", // Buffer logs for 5 seconds before sending
  };

  if (resourceAttrs.length > 0) {
    env.OTEL_RESOURCE_ATTRIBUTES = resourceAttrs.join(",");
  }

  return env;
}

/**
 * Try to read FRIDAY_KEY from env files OR fetch from cypher.
 * Cypher fetch happens first if CYPHER_TOKEN_URL is set.
 */
async function peekAtlasKey(): Promise<string | undefined> {
  // Priority 1: Fetch from cypher (Kubernetes pods)
  const cypherUrl = process.env.CYPHER_TOKEN_URL;
  if (cypherUrl) {
    try {
      const token = await fetchCypherToken(cypherUrl);
      // Set to environment so later checks find it
      process.env.FRIDAY_KEY = token;
      return token;
    } catch (error) {
      // Log but don't fail - fall through to other methods
      // Common case: running locally with CYPHER_TOKEN_URL set but no Kubernetes token file
      logger.warn("Failed to fetch token from cypher, falling back to .env", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Priority 2: Check if already in environment (from shell or --env-file)
  const fromEnv = process.env.FRIDAY_KEY;
  if (fromEnv) return fromEnv;

  // Priority 3: Check ~/.friday/local/.env
  const globalEnvPath = join(getFridayHome(), ".env");
  try {
    if (await exists(globalEnvPath)) {
      const content = await readFile(globalEnvPath, "utf-8");
      const parsed = parse(content);
      if (parsed.FRIDAY_KEY) return parsed.FRIDAY_KEY;
    }
  } catch {
    // Ignore read errors
  }

  // Priority 4: Check /etc/atlas/env (Linux system installs)
  if (process.platform === "linux") {
    try {
      const systemEnvPath = "/etc/atlas/env";
      if (await exists(systemEnvPath)) {
        const content = await readFile(systemEnvPath, "utf-8");
        const parsed = parse(content);
        if (parsed.FRIDAY_KEY) return parsed.FRIDAY_KEY;
      }
    } catch {
      // Ignore read errors
    }
  }

  // Priority 5: Generate an ephemeral self-signed FRIDAY_KEY for this daemon
  // process. Friday Studio runs single-user-local-first; without a key,
  // authenticated routes (skill publish, workspace creation) return 401 and
  // leave the user with no clear path to recovery. Mirrors the Docker
  // entrypoint's auto-generate behavior so the desktop binary works offline.
  return ensureLocalFridayKey();
}

/**
 * Check if OTEL is properly configured for this process.
 * Returns true if OTEL will be/is active.
 */
function isOtelConfigured(): boolean {
  return process.env.OTEL_DENO === "true" && !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
}

/**
 * Re-exec the current process with OTEL environment variables.
 * This is needed because OTEL initializes BEFORE JavaScript runs.
 * After re-exec, isOtelConfigured() returns true, preventing infinite loops.
 */
async function reExecWithOtel(atlasKey: string): Promise<never> {
  const otelEnv = buildOtelEnv(atlasKey);
  const mergedEnv = { ...process.env, ...otelEnv } as Record<string, string>;

  const cmd = new Deno.Command(Deno.execPath(), {
    args: buildCommandArgs(Deno.args),
    env: mergedEnv,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const childProcess = cmd.spawn();

  // Forward signals to child process so launchctl stop works correctly.
  // When launchd sends SIGTERM to this wrapper process, we need to relay it
  // to the actual daemon running in the child process.
  //
  // NOTE: In Deno compiled binaries, signal listeners don't properly prevent
  // the default signal behavior. We work around this by immediately exiting
  // with code 0 after forwarding the signal. This makes launchd's KeepAlive
  // see a successful exit and not restart the service.
  const forwardSignalAndExit = () => {
    try {
      childProcess.kill("SIGTERM");
    } catch {
      // Child may have already exited
    }
    // Exit immediately with 0 to signal clean shutdown to launchd
    process.exit(0);
  };
  Deno.addSignalListener("SIGTERM", forwardSignalAndExit);
  Deno.addSignalListener("SIGINT", forwardSignalAndExit);

  // Normal exit path - wait for child and propagate its exit code.
  const status = await childProcess.status;
  process.exit(status.code);
}

interface StartArgs {
  port?: number;
  hostname?: string;
  detached?: boolean;
  maxWorkspaces?: number;
  idleTimeout?: number;
  logLevel?: string;
  atlasConfig?: string;
}

export const command = "start";
export const desc = "Start the Atlas daemon";
export const aliases = ["run"];

export const examples = [
  ["$0 daemon start", "Start daemon on default port 8080"],
  ["$0 daemon start --port 3000", "Start daemon on specific port"],
  ["$0 daemon start --detached", "Start daemon in background mode"],
  ["$0 daemon start --max-workspaces 20", "Start with higher workspace limit"],
];

export function builder(y: YargsInstance) {
  return y
    .option("port", {
      type: "number",
      alias: "p",
      describe: "Port to run the daemon on",
      default: 8080,
    })
    .option("hostname", { type: "string", describe: "Hostname to bind to", default: "127.0.0.1" })
    .option("detached", {
      type: "boolean",
      alias: "d",
      describe: "Run daemon in background (detached mode)",
      default: false,
    })
    .option("max-workspaces", {
      type: "number",
      describe: "Maximum number of concurrent workspace runtimes",
      default: 10,
    })
    .option("idle-timeout", {
      type: "number",
      describe: "Idle timeout for workspace runtimes in seconds",
      default: 300, // 5 minutes
    })
    .option("logLevel", {
      type: "string",
      describe: "Logging level (debug, info, warn, error)",
      choices: ["debug", "info", "warn", "error"],
    })
    .option("atlas-config", {
      type: "string",
      describe: "Path to friday.yml configuration directory",
      alias: "c",
    })
    .example("$0 daemon start", "Start daemon on default port 8080")
    .example("$0 daemon start --port 3000", "Start daemon on specific port")
    .example("$0 daemon start --detached", "Start daemon in background mode")
    .example("$0 daemon start --max-workspaces 20", "Start with higher workspace limit")
    .example(
      "$0 daemon start --atlas-config /path/to/config",
      "Start with custom atlas config path",
    );
}

export const handler = async (argv: StartArgs): Promise<void> => {
  // Fetch FRIDAY_KEY early - needed for both OTEL config and credentials.
  // In Kubernetes: fetches from cypher via CYPHER_TOKEN_URL
  // On desktop: reads from .env files or environment
  const atlasKey = await peekAtlasKey();

  // OTEL re-exec check: Must happen BEFORE any other initialization.
  // OTEL in Deno initializes before JavaScript runs, so we need to re-exec
  // with proper env vars if FRIDAY_KEY is present but OTEL isn't configured.
  // After re-exec, isOtelConfigured() returns true, preventing infinite loops.
  // Note: In Kubernetes, OTEL is pre-configured in pod spec, so we skip re-exec.
  if (!isOtelConfigured() && atlasKey) {
    // Re-exec with OTEL configured - this never returns
    await reExecWithOtel(atlasKey);
  }

  try {
    // Validate port
    if (argv.port && (argv.port < 1 || argv.port > 65535)) {
      errorOutput(`Invalid port number: ${argv.port}. Port must be between 1 and 65535.`);
      process.exit(1);
    }

    // Check if daemon is already running
    const port = argv.port || 8080;
    const isRunning = await parseResult(client.health.index.$get());
    if (isRunning.ok) {
      infoOutput(`Atlas daemon is already running on port ${port}`);
      const status = await parseResult(client.daemon.status.$get());
      if (status.ok) {
        displayDaemonStatus(status.data, port);
      }
      process.exit(0);
    }

    // Load environment variables
    await load({ export: true });

    // Load system Atlas configuration (Linux packages)
    if (process.platform === "linux") {
      const systemAtlasEnv = "/etc/atlas/env";
      if (await exists(systemAtlasEnv)) {
        await load({ export: true, envPath: systemAtlasEnv });
      }
    }

    // Load global Atlas configuration as fallback
    const globalAtlasEnv = join(getFridayHome(), ".env");
    if (await exists(globalAtlasEnv)) {
      await load({ export: true, envPath: globalAtlasEnv });
    }

    // Smart PATH augmentation for npx and other tools
    // This ensures compiled binaries can find tools like npx for MCP servers
    const augmentPathWithTool = async (toolPath: string | undefined, toolName: string) => {
      if (!toolPath) return;
      try {
        // First validate the tool path exists and is executable
        try {
          // Follow symlinks to get the real path
          let realPath = toolPath;
          try {
            realPath = await Deno.realPath(toolPath);
            logger.debug(`Resolved ${toolName} symlink: ${toolPath} -> ${realPath}`);
          } catch {
            // Not a symlink or doesn't exist, use original path
            realPath = toolPath;
          }

          // Check if the path exists and is a file (after following symlinks)
          const fileInfo = await stat(realPath);
          if (!fileInfo.isFile()) {
            logger.warn(`${toolName} path is not a file: ${realPath} (original: ${toolPath})`);
            return;
          }

          // Check if executable by examining file permissions (more robust than running)
          if (process.platform !== "win32") {
            // On Unix-like systems, check if file has execute permission
            // mode is a number where execute permissions are:
            // - owner execute: 0o100
            // - group execute: 0o010
            // - other execute: 0o001
            const mode = fileInfo.mode;
            const isExecutable = (mode & 0o111) !== 0; // Check any execute bit

            if (!isExecutable) {
              logger.warn(
                `${toolName} is not executable (mode: ${mode.toString(
                  8,
                )}): ${realPath} (original: ${toolPath})`,
              );
              return;
            }

            logger.debug(`${toolName} is executable (mode: ${mode.toString(8)}): ${realPath}`);
          }
          // On Windows, .cmd and .exe files are executable by default if they exist
        } catch (error) {
          logger.warn(`${toolName} path does not exist or is not accessible: ${toolPath}`, {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }

        // Extract directory from tool path using proper path utilities
        const toolDir = dirname(toolPath);
        const currentPath = process.env.PATH || "";
        const separator = process.platform === "win32" ? ";" : ":";

        // Check if tool directory is already in PATH
        const pathSegments = currentPath.split(separator);
        if (!pathSegments.includes(toolDir)) {
          // Prepend tool directory to PATH for higher priority
          const newPath = `${toolDir}${separator}${currentPath}`;
          process.env.PATH = newPath;
          logger.info(`Added ${toolName} to PATH`, { toolPath, toolDir });
        } else {
          logger.debug(`${toolName} directory already in PATH`, { toolDir });
        }
      } catch (error) {
        logger.warn(`Failed to augment PATH with ${toolName}`, {
          error: error instanceof Error ? error.message : String(error),
          toolPath,
        });
      }
    };

    // On macOS, add common homebrew bin directories to PATH if not already present.
    // Daemon processes launched via launchd or detached mode inherit a restricted
    // PATH that often excludes /opt/homebrew/bin (Apple Silicon) and /usr/local/bin
    // (Intel), so tools like uvx and npx aren't found even when installed.
    if (process.platform === "darwin") {
      const homebrewPaths = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
      const currentPath = process.env.PATH ?? "";
      const separator = ":";
      const pathSegments = new Set(currentPath.split(separator));
      const missing = homebrewPaths.filter((p) => !pathSegments.has(p));
      if (missing.length > 0) {
        process.env.PATH = [...missing, currentPath].join(separator);
        logger.debug("Augmented PATH with homebrew directories", { added: missing });
      }
    }

    // Check for FRIDAY_NPX_PATH and augment PATH if needed
    const npxPath = process.env.FRIDAY_NPX_PATH;
    if (npxPath) {
      await augmentPathWithTool(npxPath, "npx");
    } else {
      logger.debug("No FRIDAY_NPX_PATH configured, MCP servers using npx may not work");
    }

    // Check for FRIDAY_NODE_PATH and augment PATH if needed (for bundled claude-code agent)
    const nodePath = process.env.FRIDAY_NODE_PATH;
    if (nodePath) {
      await augmentPathWithTool(nodePath, "node");
    } else {
      logger.debug("No FRIDAY_NODE_PATH configured, bundled claude-code agent may not work");
    }

    // Check for FRIDAY_UVX_PATH / FRIDAY_UV_PATH and augment PATH if needed
    // (for MCP servers using uvx/pipx — uvx ships alongside uv in the same bin dir)
    const uvxPath = process.env.FRIDAY_UVX_PATH ?? process.env.FRIDAY_UV_PATH;
    if (uvxPath) {
      await augmentPathWithTool(uvxPath, "uvx");
    } else {
      logger.debug(
        "No FRIDAY_UVX_PATH or FRIDAY_UV_PATH configured, MCP servers using uvx rely on PATH",
      );
    }

    // Check for FRIDAY_AGENT_BROWSER_PATH and augment PATH for the web
    // agent's execFile("agent-browser", ...) call at
    // packages/bundled-agents/src/web/tools/browse.ts:67. The launcher's
    // fridayEnv() in tools/friday-launcher/project.go emits this when
    // the bundled binary is present at <binDir>/agent-browser.
    const agentBrowserPath = process.env.FRIDAY_AGENT_BROWSER_PATH;
    if (agentBrowserPath) {
      await augmentPathWithTool(agentBrowserPath, "agent-browser");
    } else {
      logger.debug("No FRIDAY_AGENT_BROWSER_PATH configured, web agent's browse tool may not work");
    }

    // Check for FRIDAY_KEY and fetch credentials if present
    const atlasKey = process.env.FRIDAY_KEY;
    const localOnlyMode = isLocalOnlyMode(process.env.FRIDAY_LOCAL_ONLY);

    if (atlasKey && !localOnlyMode) {
      logger.info("Atlas key detected, fetching credentials...");

      try {
        const credentials = await fetchCredentials({ atlasKey, retries: 3, retryDelay: 2000 });
        const { setCount, skippedCount } = setToEnv(credentials);

        logger.info(
          `Credentials fetched successfully: ${setCount} set, ${skippedCount} skipped (already configured)`,
        );
      } catch (error) {
        logger.error(
          `Failed to fetch credentials: ${error instanceof Error ? error.message : String(error)}`,
        );
        logger.error("Continuing with existing environment variables...");

        errorOutput("\nFailed to fetch credentials with FRIDAY_KEY.");
        errorOutput(
          `Please check your FRIDAY_KEY in ${join(getFridayHome(), ".env")} and restart the daemon.`,
        );
        process.exit(1);
      }
    } else if (atlasKey && localOnlyMode) {
      logger.info("FRIDAY_LOCAL_ONLY mode enabled - skipping Atlas API credential fetch");
      logger.info("Using only locally configured environment variables");
      logger.info(
        "Ensure all required API keys (ANTHROPIC_API_KEY, etc.) are set in your environment",
      );
    } else if (localOnlyMode) {
      logger.info("FRIDAY_LOCAL_ONLY mode enabled - using only local environment variables");
    }

    // Set atlas config path if provided
    if (argv.atlasConfig) {
      process.env.FRIDAY_CONFIG_PATH = argv.atlasConfig;
    }

    if (argv.detached) {
      await startDetached(argv);
    } else {
      await startForeground(argv);
    }
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

/**
 * Check if FRIDAY_LOCAL_ONLY mode is enabled
 */
function isLocalOnlyMode(value: string | undefined): boolean {
  if (!value) return false;
  const normalizedValue = value.toLowerCase().trim();
  return ["true", "1", "yes", "on"].includes(normalizedValue);
}

async function startDetached(argv: StartArgs): Promise<void> {
  // On Windows, use VBScript for true background process
  if (process.platform === "win32") {
    await startWindowsDetached(argv);
    return;
  }

  const cmd = new Deno.Command(Deno.execPath(), {
    args: buildCommandArgs(buildDaemonArgs(argv)),
    env: process.env as Record<string, string>,
    stdout: "null",
    stderr: "null",
    stdin: "null",
  });

  const child = cmd.spawn();
  const pid = child.pid;

  // Give it a moment to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Check if it's running
  const isRunning = await parseResult(client.health.index.$get());
  if (isRunning.ok) {
    successOutput(`Atlas daemon started in background`);
    successOutput(`PID: ${pid}`);
    successOutput(`Port: ${argv.port || 8080}`);
    successOutput(`Status: atlas daemon status`);
  } else {
    errorOutput("Failed to start daemon in background");
    process.exit(1);
  }

  process.exit(0);
}

async function startWindowsDetached(argv: StartArgs): Promise<void> {
  const execPath = Deno.execPath();
  const args = buildCommandArgs(buildDaemonArgs(argv));

  // Create a VBScript to launch atlas in background (more reliable than PowerShell)
  const tempDir = await makeTempDir();
  const vbsFile = `${tempDir}\\atlas-daemon.vbs`;

  // Build command line
  const cmdLine = `"${execPath}" ${args.map((arg) => `"${arg}"`).join(" ")}`;

  // VBScript content - launches process truly detached
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "${cmdLine}", 0, False`;

  await writeFile(vbsFile, vbsContent, "utf-8");

  // Give VBScript a moment to launch the process
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Clean up VBScript file
  try {
    await rm(vbsFile);
    await rm(tempDir);
  } catch {
    // Ignore cleanup errors
  }

  // Give it a moment to start
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Check if it's running
  const isRunning = await parseResult(client.health.index.$get());
  if (isRunning.ok) {
    successOutput(`Atlas daemon started in background`);
    successOutput(`Port: ${argv.port || 8080}`);
    successOutput(`Status: atlas daemon status`);
  } else {
    errorOutput("Failed to start daemon in background");
    process.exit(1);
  }
}

async function startForeground(argv: StartArgs): Promise<void> {
  // Dynamic import to avoid loading daemon module chain at CLI startup.
  // Reach for the implementation source directly — `@atlas/atlasd` is a
  // type-only barrel so other CLI commands (chat, session, etc.) that touch
  // the daemon's route types via @atlas/client don't drag the daemon's
  // module graph (NATS, JetStream, migrations) into their process at load.
  const { AtlasDaemon } = await import("@atlas/atlasd/daemon");
  const daemon = new AtlasDaemon({
    port: argv.port,
    hostname: argv.hostname,
    maxConcurrentWorkspaces: argv.maxWorkspaces,
    idleTimeoutMs: (argv.idleTimeout || 300) * 1000,
    cors: ["http://127.0.0.1:1420"],
  });

  // Catch unhandled promise rejections so a single async error
  // (e.g. WouldBlock from a logger write) doesn't take down the process.
  globalThis.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    logger.error("Unhandled promise rejection", { error: event.reason });
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    infoOutput("\nShutting down Atlas daemon...");
    await daemon.shutdown();
    successOutput("Atlas daemon stopped successfully.");
    process.exit(0);
  };

  Deno.addSignalListener("SIGINT", shutdown);

  // SIGTERM is not supported on Windows
  if (process.platform !== "win32") {
    Deno.addSignalListener("SIGTERM", shutdown);
  }

  infoOutput(
    `Starting Atlas daemon on http://${argv.hostname || "127.0.0.1"}:${argv.port || 8080}...`,
  );
  successOutput("Atlas daemon is running. Press Ctrl+C to stop.");

  // Start the daemon
  await daemon.start();
}
