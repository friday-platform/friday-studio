import { AtlasDaemon } from "@atlas/atlasd";
import { client, parseResult } from "@atlas/client/v2";
import { fetchCredentials, setToDenoEnv } from "@atlas/core";
import { logger } from "@atlas/logger";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { load } from "@std/dotenv";
import { exists } from "@std/fs";
import { dirname, join } from "@std/path";
import { displayDaemonStatus } from "../../utils/daemon-status.ts";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import type { YargsInstance } from "../../utils/yargs.ts";

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
      describe: "Path to atlas.yml configuration directory",
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
  try {
    // Validate port
    if (argv.port && (argv.port < 1 || argv.port > 65535)) {
      errorOutput(`Invalid port number: ${argv.port}. Port must be between 1 and 65535.`);
      Deno.exit(1);
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
      Deno.exit(0);
    }

    // Load environment variables
    await load({ export: true });

    // Load system Atlas configuration (Linux packages)
    if (Deno.build.os === "linux") {
      const systemAtlasEnv = "/etc/atlas/env";
      if (await exists(systemAtlasEnv)) {
        await load({ export: true, envPath: systemAtlasEnv });
      }
    }

    // Load global Atlas configuration as fallback
    // Note: getAtlasHome() will return the appropriate path based on system/user mode
    const globalAtlasEnv = join(getAtlasHome(), ".env");
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
          const fileInfo = await Deno.stat(realPath);
          if (!fileInfo.isFile) {
            logger.warn(`${toolName} path is not a file: ${realPath} (original: ${toolPath})`);
            return;
          }

          // Check if executable by examining file permissions (more robust than running)
          if (Deno.build.os !== "windows") {
            // On Unix-like systems, check if file has execute permission
            // mode is a number where execute permissions are:
            // - owner execute: 0o100
            // - group execute: 0o010
            // - other execute: 0o001
            const mode = fileInfo.mode ?? 0;
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
        const currentPath = Deno.env.get("PATH") || "";
        const separator = Deno.build.os === "windows" ? ";" : ":";

        // Check if tool directory is already in PATH
        const pathSegments = currentPath.split(separator);
        if (!pathSegments.includes(toolDir)) {
          // Prepend tool directory to PATH for higher priority
          const newPath = `${toolDir}${separator}${currentPath}`;
          Deno.env.set("PATH", newPath);
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

    // Check for ATLAS_NPX_PATH and augment PATH if needed
    const npxPath = Deno.env.get("ATLAS_NPX_PATH");
    if (npxPath) {
      await augmentPathWithTool(npxPath, "npx");
    } else {
      logger.debug("No ATLAS_NPX_PATH configured, MCP servers using npx may not work");
    }

    // Check for ATLAS_KEY and fetch credentials if present
    const atlasKey = Deno.env.get("ATLAS_KEY");
    const localOnlyMode = isLocalOnlyMode(Deno.env.get("ATLAS_LOCAL_ONLY"));

    if (atlasKey && !localOnlyMode) {
      logger.info("Atlas key detected, fetching credentials...");

      try {
        const credentials = await fetchCredentials({ atlasKey, retries: 3, retryDelay: 2000 });
        const { setCount, skippedCount } = setToDenoEnv(credentials);

        logger.info(
          `Credentials fetched successfully: ${setCount} set, ${skippedCount} skipped (already configured)`,
        );
      } catch (error) {
        logger.error(
          `Failed to fetch credentials: ${error instanceof Error ? error.message : String(error)}`,
        );
        logger.error("Continuing with existing environment variables...");

        errorOutput("\nFailed to fetch credentials with ATLAS_KEY.");
        errorOutput("Please check your ATLAS_KEY in ~/.atlas/.env and restart the daemon.");
        Deno.exit(1);
      }
    } else if (atlasKey && localOnlyMode) {
      logger.info("ATLAS_LOCAL_ONLY mode enabled - skipping Atlas API credential fetch");
      logger.info("Using only locally configured environment variables");
      logger.info(
        "Ensure all required API keys (ANTHROPIC_API_KEY, etc.) are set in your environment",
      );
    } else if (localOnlyMode) {
      logger.info("ATLAS_LOCAL_ONLY mode enabled - using only local environment variables");
    }

    // Set atlas config path if provided
    if (argv.atlasConfig) {
      Deno.env.set("ATLAS_CONFIG_PATH", argv.atlasConfig);
    }

    if (argv.detached) {
      await startDetached(argv);
    } else {
      await startForeground(argv);
    }
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};

/**
 * Check if ATLAS_LOCAL_ONLY mode is enabled
 */
function isLocalOnlyMode(value: string | undefined): boolean {
  if (!value) return false;
  const normalizedValue = value.toLowerCase().trim();
  return ["true", "1", "yes", "on"].includes(normalizedValue);
}

async function startDetached(argv: StartArgs): Promise<void> {
  // For detached mode, spawn a new process
  const execPath = Deno.execPath();
  const mainModule = Deno.mainModule;

  // Check if we're running as a compiled binary
  const isCompiledBinary =
    execPath.endsWith("atlas-test") || execPath.endsWith("atlas") || execPath.endsWith("atlas.exe");

  // On Windows, we need to use a different approach for true background process
  if (Deno.build.os === "windows") {
    // Use Windows-specific method to start process in background
    await startWindowsDetached(argv, execPath, mainModule, isCompiledBinary);
    return;
  }

  let cmd: Deno.Command;
  if (isCompiledBinary) {
    // For compiled binaries, run the binary directly
    cmd = new Deno.Command(execPath, {
      args: [
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
      ],
      env: Deno.env.toObject(),
      stdout: "null",
      stderr: "null",
      stdin: "null",
    });
  } else {
    // For source code execution, use deno run
    const denoArgs = [
      "run",
      "--allow-all",
      "--unstable-kv",
      "--unstable-broadcast-channel",
      "--unstable-worker-options",
      "--env-file",
      mainModule,
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

    cmd = new Deno.Command(execPath, {
      args: denoArgs,
      env: Deno.env.toObject(),
      stdout: "null",
      stderr: "null",
      stdin: "null",
    });
  }

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
    Deno.exit(1);
  }

  Deno.exit(0);
}

async function startWindowsDetached(
  argv: StartArgs,
  execPath: string,
  mainModule: string,
  isCompiledBinary: boolean,
): Promise<void> {
  // Build the command arguments
  const args: string[] = [];

  if (isCompiledBinary) {
    // For compiled binaries
    args.push(
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
    );
    if (argv.logLevel) args.push("--log-level", argv.logLevel);
    if (argv.atlasConfig) args.push("--atlas-config", argv.atlasConfig);
  } else {
    // For source code execution
    args.push(
      "run",
      "--allow-all",
      "--unstable-kv",
      "--unstable-broadcast-channel",
      "--unstable-worker-options",
      "--env-file",
      mainModule,
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
    );
    if (argv.logLevel) args.push("--log-level", argv.logLevel);
    if (argv.atlasConfig) args.push("--atlas-config", argv.atlasConfig);
  }

  // Create a VBScript to launch atlas in background (more reliable than PowerShell)
  const tempDir = await Deno.makeTempDir();
  const vbsFile = `${tempDir}\\atlas-daemon.vbs`;

  // Build command line
  const cmdLine = `"${execPath}" ${args.map((arg) => `"${arg}"`).join(" ")}`;

  // VBScript content - launches process truly detached
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "${cmdLine}", 0, False`;

  await Deno.writeTextFile(vbsFile, vbsContent);

  // Give VBScript a moment to launch the process
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Clean up VBScript file
  try {
    await Deno.remove(vbsFile);
    await Deno.remove(tempDir);
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
    Deno.exit(1);
  }
}

async function startForeground(argv: StartArgs): Promise<void> {
  const daemon = new AtlasDaemon({
    port: argv.port,
    hostname: argv.hostname,
    maxConcurrentWorkspaces: argv.maxWorkspaces,
    idleTimeoutMs: (argv.idleTimeout || 300) * 1000,
    cors: ["tauri://localhost", "http://127.0.0.1:1420"],
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    infoOutput("\nShutting down Atlas daemon...");
    await daemon.shutdown();
    successOutput("Atlas daemon stopped successfully.");
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", shutdown);

  // SIGTERM is not supported on Windows
  if (Deno.build.os !== "windows") {
    Deno.addSignalListener("SIGTERM", shutdown);
  }

  infoOutput(
    `Starting Atlas daemon on http://${argv.hostname || "127.0.0.1"}:${argv.port || 8080}...`,
  );
  successOutput("Atlas daemon is running. Press Ctrl+C to stop.");

  // Start the daemon
  await daemon.start();
}
