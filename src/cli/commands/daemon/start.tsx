import { load } from "@std/dotenv";
import { AtlasDaemon } from "../../../core/atlas-daemon.ts";
import { getWorkspaceManager } from "../../../core/workspace-manager.ts";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import { YargsInstance } from "../../utils/yargs.ts";
import { displayDaemonStatus, fetchDaemonStatus } from "../../utils/daemon-status.ts";

interface StartArgs {
  port?: number;
  hostname?: string;
  detached?: boolean;
  maxWorkspaces?: number;
  idleTimeout?: number;
  logLevel?: string;
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
    .option("hostname", {
      type: "string",
      describe: "Hostname to bind to",
      default: "localhost",
    })
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
    .example("$0 daemon start", "Start daemon on default port 8080")
    .example("$0 daemon start --port 3000", "Start daemon on specific port")
    .example("$0 daemon start --detached", "Start daemon in background mode")
    .example("$0 daemon start --max-workspaces 20", "Start with higher workspace limit");
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
    const isRunning = await checkDaemonRunning(port);
    if (isRunning) {
      infoOutput(`Atlas daemon is already running on port ${port}`);
      const status = await fetchDaemonStatus(port);
      if (status) {
        displayDaemonStatus(status, port);
      }
      Deno.exit(0);
    }

    // Load environment variables
    await load({ export: true });

    // Initialize workspace registry
    const registry = getWorkspaceManager();
    await registry.initialize();

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

async function checkDaemonRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function startDetached(argv: StartArgs): Promise<void> {
  // For detached mode, spawn a new process
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      "--unstable-kv",
      "--unstable-broadcast-channel",
      "--unstable-worker-options",
      "--env-file",
      Deno.mainModule,
      "daemon",
      "start",
      "--port",
      (argv.port || 8080).toString(),
      "--hostname",
      argv.hostname || "localhost",
      "--max-workspaces",
      (argv.maxWorkspaces || 10).toString(),
      "--idle-timeout",
      (argv.idleTimeout || 300).toString(),
      ...(argv.logLevel ? ["--log-level", argv.logLevel] : []),
    ],
    env: {
      ...Deno.env.toObject(),
      ATLAS_DETACHED: "true",
    },
    stdout: "null",
    stderr: "null",
    stdin: "null",
  });

  const child = cmd.spawn();
  const pid = child.pid;

  // Give it a moment to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Check if it's running
  const isRunning = await checkDaemonRunning(argv.port || 8080);
  if (isRunning) {
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

async function startForeground(argv: StartArgs): Promise<void> {
  const daemon = new AtlasDaemon({
    port: argv.port,
    hostname: argv.hostname,
    maxConcurrentWorkspaces: argv.maxWorkspaces,
    idleTimeoutMs: (argv.idleTimeout || 300) * 1000,
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    infoOutput("\nShutting down Atlas daemon...");
    await daemon.shutdown();
    successOutput("Atlas daemon stopped successfully.");
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  infoOutput(
    `Starting Atlas daemon on http://${argv.hostname || "localhost"}:${argv.port || 8080}...`,
  );
  successOutput("Atlas daemon is running. Press Ctrl+C to stop.");

  // Start the daemon
  await daemon.start();
}
