import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { FullScreenBox } from "fullscreen-ink";
import { Badge } from "@inkjs/ui";
import * as yaml from "https://deno.land/std@0.208.0/yaml/mod.ts";
import { exists } from "https://deno.land/std@0.208.0/fs/exists.ts";
import { Tab, TabGroup, useTabNavigation } from "../components/tabs.tsx";
import { type AvailableWorkspace, SplashScreen } from "../components/splash-screen.tsx";

// Parse command arguments while preserving JSON structure
function parseCommandArgs(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let braceDepth = 0;
  let i = 0;

  while (i < command.length) {
    const char = command[i];

    if (char === '"' && braceDepth === 0) {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === "{") {
      braceDepth++;
      current += char;
    } else if (char === "}") {
      braceDepth--;
      current += char;
    } else if (char === " " && !inQuotes && braceDepth === 0) {
      if (current.trim()) {
        args.push(current.trim());
        current = "";
      }
    } else {
      current += char;
    }
    i++;
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

interface LogEntry {
  type: "server" | "user" | "command" | "error";
  content: string;
  timestamp: string;
  fullContent?: string; // Store full content for truncated entries
  isPasted?: boolean; // Track if this was pasted content
}

interface ServerStatus {
  running: boolean;
  port?: number;
  workspace?: string;
  error?: string;
}

// Initial welcome messages that should always be present
const INITIAL_MESSAGES: LogEntry[] = [
  {
    type: "command",
    content: "Atlas TUI started - Navigation: Tab/j/k/gg/G/Ctrl+D/U",
    timestamp: new Date().toTimeString().slice(0, 8),
  },
  {
    type: "command",
    content: "Server will start automatically...",
    timestamp: new Date().toTimeString().slice(0, 8),
  },
];

interface TUICommandProps {
  flags?: Record<string, unknown> & {
    workspace?: string;
  };
}

const TUICommand: React.FC<TUICommandProps> = ({ flags = {} }) => {
  const [input, setInput] = useState("");
  const [serverLogs, setServerLogs] = useState<LogEntry[]>(INITIAL_MESSAGES);
  const [serverStatus, setServerStatus] = useState<ServerStatus>({
    running: false,
  });
  const {
    activeTab,
    nextTab: _nextTab,
    previousTab: _previousTab,
    goToTab,
  } = useTabNavigation({
    tabCount: 2,
    initialTab: 0,
  });
  const [inputFocused, setInputFocused] = useState(true);
  const [conversationScroll, setConversationScroll] = useState(0);
  const [serverScroll, setServerScroll] = useState(0);
  const [showPopover, setShowPopover] = useState(false);
  const [popoverContent, setPopoverContent] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [debugMode, _setDebugMode] = useState(false);
  const [showSplashScreen, setShowSplashScreen] = useState(false);
  const [availableWorkspaces, setAvailableWorkspaces] = useState<
    AvailableWorkspace[]
  >([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [selectedWorkspaceIndex, setSelectedWorkspaceIndex] = useState(0);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const serverProcessRef = useRef<Deno.ChildProcess | null>(null);
  const _inputBufferRef = useRef("");
  const inputTimeoutRef = useRef<number | null>(null);
  const pasteDetectionRef = useRef<number>(0);
  const keySequenceRef = useRef<string>("");
  const keySequenceTimeoutRef = useRef<number | null>(null);

  // Calculate available height for panels (terminal height minus header, input, status)
  const availableHeight = Math.max(10, (stdout.rows || 24) - 6);

  // Initialize server on startup
  useEffect(() => {
    initializeWorkspace();
    return () => {
      if (serverProcessRef.current && serverProcessRef.current.status !== "exited") {
        try {
          serverProcessRef.current.kill();
        } catch (error) {
          // Process already terminated, ignore error
        }
      }
      // Clean up input timeout
      if (inputTimeoutRef.current) {
        clearTimeout(inputTimeoutRef.current);
      }
      // Clean up key sequence timeout
      if (keySequenceTimeoutRef.current) {
        clearTimeout(keySequenceTimeoutRef.current);
      }
    };
  }, []);

  const addLog = (
    type: LogEntry["type"],
    content: string,
    isPasted = false,
  ) => {
    const timestamp = new Date().toTimeString().slice(0, 8);
    // Use reasonable truncation for all logs to prevent wrapping issues
    const maxDisplayLength = type === "server" ? 100 : 120;
    const truncated = content.length > maxDisplayLength;
    const displayContent = truncated ? content.slice(0, maxDisplayLength) + "..." : content;

    setServerLogs((prev: LogEntry[]) => {
      // For conversation logs (user, command, error), keep all history
      // For server logs, limit to last 150 to prevent memory issues
      const isConversationLog = type === "user" || type === "command" || type === "error";

      if (isConversationLog) {
        // Keep all conversation logs - no limit
        return [
          ...prev,
          {
            type,
            content: displayContent,
            timestamp,
            fullContent: truncated ? content : undefined,
            isPasted,
          },
        ];
      } else {
        // For server logs, apply the 150 limit
        const nonInitialLogs = prev.slice(INITIAL_MESSAGES.length);
        const serverLogs = nonInitialLogs.filter(
          (log) => log.type === "server",
        );
        const conversationLogs = nonInitialLogs.filter(
          (log) => log.type !== "server",
        );
        const recentServerLogs = serverLogs.slice(-150); // Keep last 150 server logs

        return [
          ...INITIAL_MESSAGES, // Always include the initial messages
          ...conversationLogs, // Keep all conversation logs
          ...recentServerLogs, // Limit server logs
          {
            type,
            content: displayContent,
            timestamp,
            fullContent: truncated ? content : undefined,
            isPasted,
          },
        ];
      }
    });
  };

  const [selectedLogIndex, setSelectedLogIndex] = useState(0); // Start with first log selected
  const [selectedServerLogIndex, setSelectedServerLogIndex] = useState(-1); // Will be set to last log

  // Function to scan for available workspaces
  const scanAvailableWorkspaces = async (): Promise<AvailableWorkspace[]> => {
    try {
      const gitRoot = new Deno.Command("git", {
        args: ["rev-parse", "--show-toplevel"],
      }).outputSync();

      if (!gitRoot.success) {
        return [];
      }

      const rootPath = new TextDecoder().decode(gitRoot.stdout).trim();
      const workspacesPath = `${rootPath}/examples/workspaces`;

      // Check if workspaces directory exists
      if (!(await exists(workspacesPath))) {
        return [];
      }

      const workspaces: AvailableWorkspace[] = [];

      // Read workspaces directory
      for await (const dirEntry of Deno.readDir(workspacesPath)) {
        if (dirEntry.isDirectory) {
          const workspacePath = `${workspacesPath}/${dirEntry.name}`;
          const workspaceYmlPath = `${workspacePath}/workspace.yml`;

          if (await exists(workspaceYmlPath)) {
            try {
              const workspaceYaml = await Deno.readTextFile(workspaceYmlPath);
              const config = yaml.parse(workspaceYaml) as {
                workspace?: { name?: string; description?: string };
              };

              if (config.workspace?.name) {
                workspaces.push({
                  name: config.workspace.name,
                  path: workspacePath,
                  description: config.workspace.description,
                });
              }
            } catch (error) {
              // Skip workspaces with invalid YAML
              console.warn(
                `Failed to parse workspace.yml in ${dirEntry.name}:`,
                error,
              );
            }
          }
        }
      }

      return workspaces.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      console.warn("Failed to scan available workspaces:", error);
      return [];
    }
  };

  // Function to handle workspace selection and loading
  const loadSelectedWorkspace = async (workspace: AvailableWorkspace) => {
    try {
      addLog("command", `Loading workspace: ${workspace.name}`);
      addLog("command", `Changing directory to: ${workspace.path}`);

      // Change to the workspace directory
      Deno.chdir(workspace.path);

      // Verify workspace.yml exists in the target directory
      if (await exists("workspace.yml")) {
        setShowSplashScreen(false);
        addLog("command", `Workspace ${workspace.name} loaded successfully`);
        // Start server in the new workspace directory
        await startServer();
      } else {
        addLog("error", `No workspace.yml found in ${workspace.path}`);
      }
    } catch (error) {
      addLog("error", `Failed to load workspace: ${error}`);
    }
  };

  // Initialize workspace based on flags or current directory
  const initializeWorkspace = async () => {
    const workspaceFlag = (flags as any)?.workspace as string | undefined;

    if (workspaceFlag) {
      // Load specific workspace from examples directory
      await loadWorkspaceFromFlag(workspaceFlag);
    } else {
      // Use existing logic for current directory
      await startServer();
    }
  };

  // Load workspace from --workspace flag
  const loadWorkspaceFromFlag = async (workspaceName: string) => {
    try {
      addLog("command", `Loading workspace from flag: ${workspaceName}`);

      // Find git repository root
      const gitRoot = new Deno.Command("git", {
        args: ["rev-parse", "--show-toplevel"],
      }).outputSync();

      if (!gitRoot.success) {
        throw new Error("Not in a git repository");
      }

      const rootPath = new TextDecoder().decode(gitRoot.stdout).trim();
      const workspacePath = `${rootPath}/examples/workspaces/${workspaceName}`;
      const workspaceYmlPath = `${workspacePath}/workspace.yml`;

      // Check if workspace exists
      if (!(await exists(workspaceYmlPath))) {
        throw new Error(`Workspace '${workspaceName}' not found in examples/workspaces/`);
      }

      // Change to workspace directory and load
      addLog("command", `Changing directory to: ${workspacePath}`);
      Deno.chdir(workspacePath);

      // Verify workspace.yml exists in the target directory
      if (await exists("workspace.yml")) {
        addLog("command", `Workspace ${workspaceName} loaded successfully`);
        await startServer();
      } else {
        throw new Error(`No workspace.yml found in ${workspacePath}`);
      }
    } catch (error) {
      addLog("error", `Failed to load workspace '${workspaceName}': ${error}`);
      // Fall back to normal startup behavior
      await startServer();
    }
  };

  const startServer = async () => {
    try {
      // Check if workspace.yml exists
      if (!(await exists("workspace.yml"))) {
        setShowSplashScreen(true);
        setInputFocused(false); // Ensure input is not focused in splash screen
        addLog("error", "No workspace.yml found in current directory");
        addLog("command", "Scanning for available workspaces...");

        // Scan for available workspaces
        setWorkspacesLoading(true);
        const workspaces = await scanAvailableWorkspaces();
        console.log("Setting workspaces in state:", workspaces);
        setAvailableWorkspaces(workspaces);
        setSelectedWorkspaceIndex(0); // Reset selection when workspaces change
        setWorkspacesLoading(false);

        if (workspaces.length > 0) {
          addLog(
            "command",
            `Found ${workspaces.length} available workspace(s)`,
          );
          workspaces.forEach((ws) => {
            addLog("command", `- ${ws.name}`);
          });
        } else {
          addLog("command", "No example workspaces found");
        }

        addLog(
          "command",
          "Showing splash screen - create a workspace to continue",
        );
        return;
      }

      const workspaceYaml = await Deno.readTextFile("workspace.yml");
      const config = yaml.parse(workspaceYaml) as {
        workspace?: { name?: string };
      };

      addLog(
        "server",
        `Starting ${config.workspace?.name || "workspace"} server...`,
      );

      // Start server process
      const gitRoot = new Deno.Command("git", {
        args: ["rev-parse", "--show-toplevel"],
      }).outputSync();

      if (!gitRoot.success) {
        addLog("error", "Failed to find git repository root");
        return;
      }

      const rootPath = new TextDecoder().decode(gitRoot.stdout).trim();
      const cliPath = `${rootPath}/src/cli.tsx`;

      const serverProcess = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-all",
          "--unstable-broadcast-channel",
          "--unstable-worker-options",
          "--unstable-otel",
          "--env-file",
          cliPath,
          "workspace",
          "serve",
        ],
        stdout: "piped",
        stderr: "piped",
        env: {
          OTEL_DENO: "true",
          OTEL_SERVICE_NAME: "atlas-tui",
          OTEL_SERVICE_VERSION: "1.0.0",
          OTEL_RESOURCE_ATTRIBUTES: "service.name=atlas-tui,service.version=1.0.0",
        },
      }).spawn();

      serverProcessRef.current = serverProcess;

      // Read server output
      const readOutput = async (
        stream: ReadableStream<Uint8Array>,
        type: "server" | "error",
      ) => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const text = decoder.decode(value);
            const lines = text.split("\n").filter((line) => line.trim());

            for (const line of lines) {
              // More aggressive ANSI escape sequence cleaning
              const cleanLine = line
                // Remove all ANSI escape sequences
                // deno-lint-ignore no-control-regex
                .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
                // Remove cursor movement sequences
                // deno-lint-ignore no-control-regex
                .replace(/\x1b\[[0-9]*[ABCDEFGJKST]/g, "")
                // Remove other control sequences
                // deno-lint-ignore no-control-regex
                .replace(/\x1b\([AB]/g, "")
                // deno-lint-ignore no-control-regex
                .replace(/\x1b[=>]/g, "")
                // Remove carriage returns and extra whitespace
                .replace(/\r/g, "")
                .replace(/\[2K/g, "")
                .replace(/\[1A/g, "")
                .replace(/\[G/g, "")
                .trim();

              if (cleanLine.trim()) {
                addLog(type, cleanLine);

                // Update server status based on output
                if (
                  cleanLine.includes("Workspace server running") ||
                  cleanLine.includes("Port:")
                ) {
                  const portMatch = cleanLine.match(/port (\d+)/i) || cleanLine.match(/:(\d+)/);
                  setServerStatus({
                    running: true,
                    port: portMatch ? parseInt(portMatch[1]) : 8080,
                    workspace: config.workspace?.name,
                  });
                }
              }
            }
          }
        } catch (error) {
          addLog("error", `Stream error: ${error}`);
        } finally {
          reader.releaseLock();
        }
      };

      // Start reading both stdout and stderr
      readOutput(serverProcess.stdout, "server");
      readOutput(serverProcess.stderr, "error");
    } catch (error) {
      addLog("error", `Failed to start server: ${error}`);
      setServerStatus({ running: false, error: String(error) });
    }
  };

  const executeCommand = async (commandText: string, isPasted = false) => {
    addLog("user", commandText, isPasted);

    // Always switch back to Conversation tab when command is executed (if not in splash screen)
    if (!showSplashScreen) {
      goToTab(0);
    }

    try {
      // Handle special splash screen commands
      if (showSplashScreen) {
        if (
          commandText.trim() === "reload" ||
          commandText.trim() === "/reload"
        ) {
          addLog("command", "Checking for workspace.yml...");
          if (await exists("workspace.yml")) {
            setShowSplashScreen(false);
            addLog("command", "Workspace found! Reloading TUI...");
            await startServer();
          } else {
            addLog(
              "error",
              "No workspace.yml found. Use 'atlas init' to create one.",
            );
          }
          return;
        }
      }

      // Handle help command
      if (commandText.trim() === "help" || commandText.trim() === "/help") {
        showHelpCommands();
        return;
      }

      // ONLY handle slash commands
      if (commandText.startsWith("/")) {
        const command = commandText.slice(1); // Remove the '/'
        const args = parseCommandArgs(command);

        // Special handling for init command in splash screen
        if (showSplashScreen && args[0] === "init") {
          await executeCliCommand("init", args.slice(1));
          // After init, check if workspace was created
          setTimeout(async () => {
            if (await exists("workspace.yml")) {
              addLog("command", "Workspace created! Reloading TUI...");
              setShowSplashScreen(false);
              await startServer();
            }
          }, 1000);
          return;
        }

        // Prevent workspace serve since TUI already has server running
        if (args[0] === "workspace" && args[1] === "serve") {
          addLog(
            "error",
            "Cannot run /workspace serve - server is already running in TUI",
          );
          return;
        }

        await executeCliCommand(args[0], args.slice(1));
        return;
      }

      // Non-slash commands are not supported
      if (showSplashScreen) {
        addLog(
          "command",
          'Available commands: help, reload, /init. Type "reload" after creating workspace.yml',
        );
      } else {
        addLog(
          "error",
          'Commands must start with / (e.g., /workspace serve). Type "help" for available commands.',
        );
      }
    } catch (error) {
      addLog("error", `Command failed: ${error}`);
    }
  };

  const showHelpCommands = () => {
    const helpCommands = [
      "/workspace status",
      "/workspace list",
      "/signal list",
      '/signal trigger telephone-message --data {"message": "Hello"}',
      "/session list",
      "/session get <id>",
      "/agent list",
      "/agent describe <name>",
      "/ps",
      "/logs <session-id>",
    ];

    const debugCommands = [
      "Performance Analysis: Look for [PERF] entries in server logs",
      "Debug Mode: Server includes extensive WorkspaceSupervisor debug logging",
      "OpenTelemetry: Enabled by default for performance monitoring",
      "Configuration: Supports both inline jobs and job file references",
    ];

    addLog("command", "=== Available Commands (all require / prefix) ===");
    helpCommands.forEach((cmd) => {
      addLog("command", cmd);
    });
    addLog("command", "=== Debug & Performance Features ===");
    debugCommands.forEach((feature) => {
      addLog("command", feature);
    });
    addLog(
      "command",
      "=== Navigation: j/k to select, Enter to copy to prompt ===",
    );
    addLog(
      "command",
      "=== Performance: Filter server logs by [PERF] or [DEBUG] ===",
    );
  };

  const executeCliCommand = async (command: string, args: string[]) => {
    try {
      addLog("command", `Executing: ${command} ${args.join(" ")}`);

      // For signal triggers, use HTTP API instead of spawning another CLI process
      if (
        command === "signal" &&
        args[0] === "trigger" &&
        serverStatus.running
      ) {
        const signalName = args[1];
        const dataIndex = args.indexOf("--data");
        if (dataIndex !== -1 && dataIndex + 1 < args.length) {
          // Reconstruct JSON from remaining args (in case it was split by spaces)
          const jsonData = args.slice(dataIndex + 1).join(" ");

          try {
            // Validate JSON
            JSON.parse(jsonData);

            // Send HTTP request to the running server
            const response = await fetch(
              `http://localhost:${serverStatus.port || 8080}/signals/${signalName}`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: jsonData,
              },
            );

            if (response.ok) {
              const result = await response.text();
              addLog("command", `✓ Signal triggered successfully`);
              addLog("command", result);
            } else {
              const error = await response.text();
              addLog("error", `Signal trigger failed: ${error}`);
            }
            return;
          } catch (jsonError) {
            addLog("error", `Invalid JSON: ${jsonError}`);
            return;
          }
        }
      }

      // For other commands, execute CLI directly with timeout
      const gitRoot = new Deno.Command("git", {
        args: ["rev-parse", "--show-toplevel"],
      }).outputSync();

      if (!gitRoot.success) {
        addLog("error", "Failed to find git repository root");
        return;
      }

      const rootPath = new TextDecoder().decode(gitRoot.stdout).trim();
      const cliPath = `${rootPath}/src/cli.tsx`;

      addLog(
        "command",
        `Running: deno run ... ${cliPath} ${command} ${args.join(" ")}`,
      );

      // Use spawn with timeout instead of outputSync
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      const child = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-all",
          "--unstable-broadcast-channel",
          "--unstable-worker-options",
          "--unstable-otel",
          "--env-file",
          cliPath,
          command,
          ...args,
        ],
        cwd: Deno.cwd(),
        stdout: "piped",
        stderr: "piped",
        signal: controller.signal,
        env: {
          OTEL_DENO: "true",
          OTEL_SERVICE_NAME: "atlas-tui-cli",
          OTEL_SERVICE_VERSION: "1.0.0",
          OTEL_RESOURCE_ATTRIBUTES: "service.name=atlas-tui-cli,service.version=1.0.0",
        },
      }).spawn();

      try {
        const { stdout, stderr } = await child.output();
        clearTimeout(timeoutId);

        const output = new TextDecoder().decode(stdout);
        const error = new TextDecoder().decode(stderr);

        if (output) {
          output.split("\n").forEach((line) => {
            const cleanLine = line
              // deno-lint-ignore no-control-regex
              .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
              .replace(/\[2K\[1A\[2K\[G/g, "")
              .trim();
            if (cleanLine && !cleanLine.includes("Task atlas")) {
              addLog("command", cleanLine);
            }
          });
        }

        if (error && !error.includes("Task atlas")) {
          addLog("error", error.trim());
        }
      } catch (e) {
        clearTimeout(timeoutId);
        if ((e as Error).name === "AbortError") {
          addLog("error", "Command timed out after 10 seconds");
        } else {
          addLog("error", `Command failed: ${e}`);
        }
      }
    } catch (error) {
      addLog("error", `CLI command failed: ${error}`);
    }
  };

  // Helper function to handle vi-style navigation
  const handleViNavigation = (sequence: string) => {
    const pageSize = Math.floor(availableHeight * 0.8); // 80% of visible area for page jumps

    if (activeTab === 0) {
      const maxIndex = Math.max(0, conversationLogs.length - 1);

      if (sequence === "gg") {
        // Go to top
        setSelectedLogIndex(0);
        setConversationScroll(0);
      } else if (sequence === "G") {
        // Go to bottom
        setSelectedLogIndex(maxIndex);
        if (conversationLogs.length > availableHeight) {
          setConversationScroll(conversationLogs.length - availableHeight);
        }
      } else if (sequence === "J") {
        // Page down (shift+j)
        setSelectedLogIndex((prev: number) => {
          const newIndex = Math.min(maxIndex, prev + pageSize);
          // Auto-scroll to keep selection visible
          if (newIndex >= conversationScroll + availableHeight) {
            setConversationScroll(newIndex - availableHeight + 1);
          }
          return newIndex;
        });
      } else if (sequence === "K") {
        // Page up (shift+k)
        setSelectedLogIndex((prev: number) => {
          const newIndex = Math.max(0, prev - pageSize);
          // Auto-scroll to keep selection visible
          if (newIndex < conversationScroll) {
            setConversationScroll(newIndex);
          }
          return newIndex;
        });
      }
    } else if (activeTab === 1) {
      const maxIndex = Math.max(0, serverOnlyLogs.length - 1);
      const visibleHeight = availableHeight - 8;

      if (sequence === "gg") {
        // Go to top
        setSelectedServerLogIndex(0);
        setServerScroll(0);
      } else if (sequence === "G") {
        // Go to bottom
        setSelectedServerLogIndex(maxIndex);
        if (serverOnlyLogs.length > visibleHeight) {
          setServerScroll(serverOnlyLogs.length - visibleHeight);
        }
      } else if (sequence === "J") {
        // Page down (shift+j)
        setSelectedServerLogIndex((prev: number) => {
          const newIndex = Math.min(maxIndex, prev + pageSize);
          // Auto-scroll to keep selection visible
          if (newIndex >= serverScroll + visibleHeight) {
            setServerScroll(newIndex - visibleHeight + 1);
          }
          return newIndex;
        });
      } else if (sequence === "K") {
        // Page up (shift+k)
        setSelectedServerLogIndex((prev: number) => {
          const newIndex = Math.max(0, prev - pageSize);
          // Auto-scroll to keep selection visible
          if (newIndex < serverScroll) {
            setServerScroll(newIndex);
          }
          return newIndex;
        });
      }
    }
  };

  useInput((inputChar, key) => {
    // Debug logging for all key events when debug mode is enabled
    if (debugMode && inputChar) {
      const modifiers = [];
      if (key.ctrl) modifiers.push("Ctrl");
      if (key.shift) modifiers.push("Shift");
      if (key.meta) modifiers.push("Meta");
      const modStr = modifiers.length > 0 ? `${modifiers.join("+")}+` : "";
      const special = key.upArrow
        ? "UpArrow"
        : key.downArrow
        ? "DownArrow"
        : key.tab
        ? "Tab"
        : key.return
        ? "Return"
        : key.escape
        ? "Escape"
        : "";
      const keyDesc = special || `${modStr}${inputChar}`;
      const currentPanelName = inputFocused ? "input" : activeTab === 0 ? "logs" : "commands";
      addLog("command", `Debug: Key=${keyDesc} Panel=${currentPanelName}`);
    }

    // Handle Alt + arrow keys for tab switching (Alt+b = left, Alt+f = right)
    if (
      key.meta &&
      (inputChar === "b" ||
        inputChar === "f" ||
        key.leftArrow ||
        key.rightArrow)
    ) {
      const isLeft = inputChar === "b" || key.leftArrow;
      const isRight = inputChar === "f" || key.rightArrow;

      if (isLeft) {
        // Go to previous tab
        const newTab = activeTab > 0 ? activeTab - 1 : 1; // Wrap to last tab
        goToTab(newTab);
      } else if (isRight) {
        // Go to next tab
        const newTab = activeTab < 1 ? activeTab + 1 : 0; // Wrap to first tab
        goToTab(newTab);
      }
      return;
    }

    // Debug: Log key combinations (excluding arrow keys and numbers which are handled above)
    if (
      key.meta &&
      inputChar &&
      !key.leftArrow &&
      !key.rightArrow &&
      inputChar !== "b" &&
      inputChar !== "f" &&
      !inputChar.match(/[1-9]/)
    ) {
      addLog("command", `Debug: Alt+${inputChar}`);
    }
    if (key.ctrl && inputChar) {
      addLog("command", `Debug: Ctrl+${inputChar}`);
    }

    // Handle vi navigation sequences
    if (
      !inputFocused &&
      inputChar &&
      !key.ctrl &&
      !key.meta &&
      !key.escape &&
      !key.tab &&
      !key.return
    ) {
      // Clear any existing timeout
      if (keySequenceTimeoutRef.current) {
        clearTimeout(keySequenceTimeoutRef.current);
      }

      // Handle shift+j/k for page navigation
      if (key.shift && (inputChar === "j" || inputChar === "k")) {
        handleViNavigation(inputChar.toUpperCase());
        return;
      }

      // Alternative: detect uppercase J/K directly (some terminals send this instead)
      if (inputChar === "J" || inputChar === "K") {
        handleViNavigation(inputChar);
        return;
      }

      // Build key sequence for gg and G commands
      const newSequence = keySequenceRef.current + inputChar;
      keySequenceRef.current = newSequence;

      // Check for complete sequences
      if (newSequence === "gg" || newSequence === "G") {
        handleViNavigation(newSequence);
        keySequenceRef.current = "";
        return;
      }

      // If sequence is getting too long or doesn't match any pattern, reset
      if (
        newSequence.length > 2 ||
        (newSequence.length === 2 && newSequence !== "gg")
      ) {
        keySequenceRef.current = inputChar; // Start fresh with this character
      }

      // Set timeout to clear sequence after 1 second
      keySequenceTimeoutRef.current = setTimeout(() => {
        keySequenceRef.current = "";
      }, 1000);

      // Don't process single characters that might be part of sequences
      if (inputChar === "g") {
        return;
      }
    }

    // Handle popover close with Escape
    if (key.escape && showPopover) {
      setShowPopover(false);
      setPopoverContent("");
      return;
    }

    if (key.ctrl && inputChar === "c") {
      if (serverProcessRef.current && serverProcessRef.current.status !== "exited") {
        try {
          serverProcessRef.current.kill();
        } catch (error) {
          // Process already terminated, ignore error
        }
      }
      exit();
    } else if (key.ctrl && inputChar === "v") {
      // Handle paste (Ctrl+V) - note: this may not work in all terminals
      // Most terminals handle paste at OS level, sending rapid char sequences
      return;
    } else if (key.ctrl && inputChar === "a") {
      // Toggle auto-scroll
      setAutoScroll((prev: boolean) => !prev);
    } else if (
      key.ctrl &&
      (inputChar === "d" || inputChar === "u") &&
      !inputFocused
    ) {
      // Page navigation with Ctrl+D (down) and Ctrl+U (up)
      handleViNavigation(inputChar === "d" ? "J" : "K");
      return;
    } else if (
      key.upArrow ||
      (inputChar === "k" && !inputFocused && !key.ctrl && !key.meta)
    ) {
      // Handle workspace navigation in splash screen
      if (showSplashScreen && availableWorkspaces.length > 0) {
        setSelectedWorkspaceIndex((prev: number) => Math.max(0, prev - 1));
        return;
      }

      // Navigate up in logs (older entries) and blur input to enable log interaction
      setInputFocused(false);
      if (activeTab === 0) {
        setSelectedLogIndex((prev: number) => {
          const newIndex = Math.max(0, prev - 1);
          // Auto-scroll to keep selection visible
          if (newIndex < conversationScroll) {
            setConversationScroll(newIndex);
          }
          return newIndex;
        });
      } else if (activeTab === 1) {
        setSelectedServerLogIndex((prev: number) => {
          const newIndex = Math.max(0, prev - 1);
          // Auto-scroll to keep selection visible
          if (newIndex < serverScroll) {
            setServerScroll(newIndex);
          }
          return newIndex;
        });
      }
    } else if (
      key.downArrow ||
      (inputChar === "j" && !inputFocused && !key.ctrl && !key.meta)
    ) {
      // Handle workspace navigation in splash screen
      if (showSplashScreen && availableWorkspaces.length > 0) {
        setSelectedWorkspaceIndex((prev: number) =>
          Math.min(availableWorkspaces.length - 1, prev + 1)
        );
        return;
      }

      // Navigate down in logs (newer entries) and blur input to enable log interaction
      setInputFocused(false);
      if (activeTab === 0) {
        const maxIndex = Math.max(0, conversationLogs.length - 1);
        setSelectedLogIndex((prev: number) => {
          const newIndex = Math.min(maxIndex, prev + 1);
          // Auto-scroll to keep selection visible
          if (newIndex >= conversationScroll + availableHeight) {
            setConversationScroll(newIndex - availableHeight + 1);
          }
          return newIndex;
        });
      } else if (activeTab === 1) {
        const maxIndex = Math.max(0, serverOnlyLogs.length - 1);
        setSelectedServerLogIndex((prev: number) => {
          const newIndex = Math.min(maxIndex, prev + 1);
          // Auto-scroll to keep selection visible
          const visibleHeight = availableHeight - 8;
          if (newIndex >= serverScroll + visibleHeight) {
            setServerScroll(newIndex - visibleHeight + 1);
          }
          return newIndex;
        });
      }
    } else if (key.tab && !inputFocused) {
      // Tab key refocuses input when not focused
      setInputFocused(true);
      return;
    } else if (key.return) {
      // Handle workspace selection in splash screen
      if (showSplashScreen && availableWorkspaces.length > 0) {
        const selectedWorkspace = availableWorkspaces[selectedWorkspaceIndex];
        if (selectedWorkspace) {
          loadSelectedWorkspace(selectedWorkspace);
        }
        return;
      }

      if (inputFocused) {
        // Execute command
        if (input.trim()) {
          // Check if this was likely a pasted command based on rapid input detection
          const wasPasted = pasteDetectionRef.current > 3; // More than 3 chars in rapid succession
          executeCommand(input.trim(), wasPasted);
          setInput("");
          pasteDetectionRef.current = 0; // Reset paste detection
        }
      } else {
        // Handle log selection and command population
        if (activeTab === 0) {
          const log = conversationLogs[selectedLogIndex];

          // If it's a command log that looks like a help command, populate input
          if (
            log &&
            log.type === "command" &&
            log.content &&
            !log.content.includes("===") &&
            !log.content.includes("Navigation:")
          ) {
            // Use the raw content directly since timestamps are separate now
            const command = log.content.trim();
            // Only populate if it looks like a real command (starts with /)
            if (
              command.startsWith("/") &&
              !command.includes("Executing:") &&
              !command.includes("started") &&
              !command.includes("...")
            ) {
              addLog("command", `Copying command to input: ${command}`);
              setInputFocused(true);
              setInput(() => command);
              return;
            }
          }

          // Otherwise, expand if there's full content
          if (log && (log.fullContent || log.isPasted)) {
            setPopoverContent(log.fullContent || log.content);
            setShowPopover(true);
            return;
          }
        } else if (activeTab === 1) {
          const log = serverOnlyLogs[selectedServerLogIndex];
          if (log && log.fullContent) {
            setPopoverContent(log.fullContent);
            setShowPopover(true);
            return;
          }
        }
      }
    } else if (key.backspace || key.delete) {
      // Always handle delete/backspace for input, auto-focus if needed
      if (!inputFocused) {
        setInputFocused(true);
      }
      setInput((prev: string) => prev.slice(0, -1));
    } else if (inputChar === "y" && !inputFocused) {
      // Copy selected line to clipboard using pbcopy (macOS) or equivalent
      if (activeTab === 0) {
        const log = conversationLogs[selectedLogIndex];
        if (log) {
          const textToCopy = log.fullContent || log.content;
          const copyToClipboard = async () => {
            try {
              const process = new Deno.Command("pbcopy", {
                stdin: "piped",
              }).spawn();

              const writer = process.stdin.getWriter();
              await writer.write(new TextEncoder().encode(textToCopy));
              await writer.close();
              await process.status;

              addLog(
                "command",
                `Copied to clipboard: ${textToCopy.slice(0, 50)}...`,
              );
            } catch (error) {
              addLog("error", `Failed to copy to clipboard: ${error}`);
            }
          };
          copyToClipboard();
        }
      } else if (activeTab === 1) {
        const log = serverOnlyLogs[selectedServerLogIndex];
        if (log) {
          const textToCopy = log.fullContent || log.content;
          const copyToClipboard = async () => {
            try {
              const process = new Deno.Command("pbcopy", {
                stdin: "piped",
              }).spawn();

              const writer = process.stdin.getWriter();
              await writer.write(new TextEncoder().encode(textToCopy));
              await writer.close();
              await process.status;

              addLog(
                "command",
                `Copied to clipboard: ${textToCopy.slice(0, 50)}...`,
              );
            } catch (error) {
              addLog("error", `Failed to copy to clipboard: ${error}`);
            }
          };
          copyToClipboard();
        }
      }
    } else if (inputChar === "/" && !inputFocused && !showSplashScreen) {
      // Typing '/' should focus the command prompt and add the '/'
      setInputFocused(true);
      setInput("/");
      pasteDetectionRef.current += 1;
    } else if (
      inputChar &&
      !key.ctrl &&
      !key.meta &&
      !key.escape &&
      !showSplashScreen && // Don't auto-focus input in splash screen
      // Allow input from any tab - automatically focus input when typing
      inputChar.match(/[a-zA-Z0-9\/\-_\s.,!@#$%^&*()\=+\[\]{}|;:'",<>?`~]/)
    ) {
      // Auto-focus input when typing
      if (!inputFocused) {
        setInputFocused(true);
      }

      pasteDetectionRef.current += 1;

      // Add character immediately for responsive typing
      setInput((prev: string) => {
        const newInput = prev + inputChar;
        return newInput.length > 500 ? newInput.slice(0, 500) : newInput;
      });

      // Reset paste detection counter after a delay
      setTimeout(() => {
        pasteDetectionRef.current = Math.max(0, pasteDetectionRef.current - 1);
      }, 100);
    }
  });

  // Separate conversation logs from server logs
  const conversationLogs = serverLogs.filter(
    (log: LogEntry) => log.type === "user" || log.type === "command" || log.type === "error",
  );
  const serverOnlyLogs = serverLogs.filter(
    (log: LogEntry) => log.type === "server",
  );

  // Auto-scroll conversation to bottom when new logs are added (only if auto-scroll is enabled)
  useEffect(() => {
    if (autoScroll && conversationLogs.length > 0) {
      if (conversationLogs.length > availableHeight) {
        const maxScroll = conversationLogs.length - availableHeight;
        setConversationScroll(maxScroll);
      }
      // Don't reset to 0 if there are fewer logs - preserve user's scroll position
    }
  }, [conversationLogs.length, availableHeight, autoScroll]);

  // Auto-scroll server logs to bottom when new logs are added (only if auto-scroll is enabled)
  useEffect(() => {
    if (autoScroll && serverOnlyLogs.length > 0) {
      if (serverOnlyLogs.length > availableHeight - 8) {
        const maxScroll = serverOnlyLogs.length - (availableHeight - 8);
        setServerScroll(maxScroll);
      }
      // Only auto-select latest if no selection has been made yet
      if (selectedServerLogIndex < 0) {
        setSelectedServerLogIndex(serverOnlyLogs.length - 1);
      }
    }
  }, [serverOnlyLogs.length, availableHeight, autoScroll]);

  const renderConversationTab = () => (
    <Box flexDirection="column" height={availableHeight} overflow="hidden">
      {conversationLogs
        .slice(conversationScroll, conversationScroll + availableHeight)
        .map((log: LogEntry, i: number) => {
          const globalLogIndex = i + conversationScroll;
          const displayText = log.isPasted && log.content.length > 30
            ? `[Pasted Text #${globalLogIndex + 1}] ${
              log.content.slice(
                0,
                25,
              )
            }...`
            : log.content;

          // Check if this log is selected and we're in the logs panel
          const isSelected = activeTab === 0 && selectedLogIndex === globalLogIndex;

          return (
            <Box key={globalLogIndex} flexDirection="column">
              <Text
                color={isSelected
                  ? "black"
                  : log.type === "user"
                  ? "cyan"
                  : log.type === "command"
                  ? "magenta"
                  : "red"}
                backgroundColor={isSelected ? "white" : undefined}
              >
                {isSelected ? "▶ " : ""}
                <Text color="gray">{log.timestamp}</Text> {displayText}
                {(log.fullContent || log.isPasted) && (
                  <Text
                    color={isSelected ? "black" : "yellow"}
                    backgroundColor={isSelected ? "white" : undefined}
                    dimColor={!isSelected}
                  >
                    {isSelected ? " [ENTER to expand]" : " [j/k to select, Enter to expand]"}
                  </Text>
                )}
              </Text>
            </Box>
          );
        })}
      {activeTab === 0 && conversationLogs.length > 0 && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            Selected: {selectedLogIndex + 1}/{conversationLogs.length}
          </Text>
        </Box>
      )}
    </Box>
  );

  const renderServerTab = () => (
    <Box flexDirection="column" height={availableHeight} overflow="hidden">
      <Box marginBottom={1}>
        <Text color="gray">
          {serverStatus.running ? "🟢 Running" : "🔴 Stopped"}
          {serverStatus.port && `:${serverStatus.port}`}
          {serverStatus.workspace && ` 🏢 ${serverStatus.workspace}`}
        </Text>
      </Box>
      {serverOnlyLogs
        .slice(serverScroll, serverScroll + availableHeight)
        .map((log: LogEntry, i: number) => {
          const globalLogIndex = i + serverScroll;
          const isSelected = activeTab === 1 && selectedServerLogIndex === globalLogIndex;

          // Determine log color based on content
          const isPerformanceLog = log.content.includes("[PERF]");
          const isDebugLog = log.content.includes("[DEBUG]");
          const isOtelLog = log.content.includes("OpenTelemetry");

          const logColor = isSelected
            ? "black"
            : isPerformanceLog
            ? "yellow"
            : isDebugLog
            ? "cyan"
            : isOtelLog
            ? "magenta"
            : "green";

          return (
            <Box key={globalLogIndex} flexDirection="column">
              <Text
                color={logColor}
                backgroundColor={isSelected ? "white" : undefined}
                bold={isPerformanceLog || isOtelLog}
              >
                {isSelected ? "▶ " : ""}
                {isPerformanceLog && !isSelected ? "⚡ " : ""}
                {isDebugLog && !isSelected ? "🔍 " : ""}
                {isOtelLog && !isSelected ? "📊 " : ""}
                <Text color="gray">{log.timestamp}</Text> {log.content}
                {log.fullContent && (
                  <Text
                    color={isSelected ? "black" : "gray"}
                    backgroundColor={isSelected ? "white" : undefined}
                    dimColor={!isSelected}
                  >
                    {isSelected ? " [ENTER to expand]" : " [j/k to select, Enter to expand]"}
                  </Text>
                )}
              </Text>
            </Box>
          );
        })}
      {activeTab === 1 && serverOnlyLogs.length > 0 && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            Selected: {selectedServerLogIndex + 1}/{serverOnlyLogs.length}
          </Text>
        </Box>
      )}
    </Box>
  );

  const [cursorVisible, setCursorVisible] = useState(true);

  useEffect(() => {
    if (inputFocused) {
      const interval = setInterval(() => {
        setCursorVisible((prev: boolean) => !prev);
      }, 500); // Blink every 500ms when focused

      return () => clearInterval(interval);
    } else {
      // Static cursor when not focused
      setCursorVisible(true);
    }
  }, [inputFocused]);

  const renderInputPanel = () => {
    const getCursor = () => {
      if (inputFocused) {
        return cursorVisible ? "█" : " ";
      } else {
        // Static solid cursor when not focused
        return "█";
      }
    };

    return (
      <Box flexDirection="column" paddingY={1} flexGrow={1} height={6}>
        <Box borderStyle="round" borderColor="green" paddingX={1} width="100%">
          <Text>
            {">"} {input}
            <Text color={inputFocused ? "white" : "gray"}>{getCursor()}</Text>
          </Text>
        </Box>
      </Box>
    );
  };

  return (
    <FullScreenBox flexDirection="column">
      {showSplashScreen
        ? (
          // Splash screen mode
          <Box flexGrow={1}>
            <SplashScreen
              availableWorkspaces={availableWorkspaces}
              workspacesLoading={workspacesLoading}
              selectedWorkspaceIndex={selectedWorkspaceIndex}
              onWorkspaceSelect={loadSelectedWorkspace}
            />
          </Box>
        )
        : (
          // Normal TUI mode
          <>
            <Box flexGrow={1}>
              <TabGroup
                activeTab={activeTab}
                onTabChange={(index: number) => goToTab(index)}
              >
                <Tab label="Conversation" icon="◈">
                  {renderConversationTab()}
                </Tab>
                <Tab label="Server Output" icon="▦">
                  {renderServerTab()}
                </Tab>
              </TabGroup>
            </Box>

            {/* Always visible input panel at bottom */}
            {renderInputPanel()}
          </>
        )}

      {/* Full-screen content preview */}
      {showPopover && (
        <Box
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          padding={1}
          flexDirection="column"
          backgroundColor="black"
        >
          <Box
            borderStyle="double"
            borderColor="cyan"
            backgroundColor="black"
            padding={1}
            flexDirection="column"
            height="100%"
          >
            <Box borderStyle="single" borderColor="cyan" paddingX={1}>
              <Text bold color="cyan">
                📄 Full Content Preview
              </Text>
              <Text color="gray">- Press Esc to close</Text>
            </Box>
            <Box
              flexGrow={1}
              overflow="hidden"
              flexDirection="column"
              padding={1}
              marginTop={1}
              backgroundColor="black"
            >
              <Text color="white" wrap="wrap">
                {popoverContent}
              </Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* Status Bar */}
      <Box paddingX={1} borderTop borderColor="gray">
        <Text bold color="yellow">
          ▣ {showSplashScreen ? "Atlas (No Workspace)" : serverStatus.workspace || "Atlas"}
        </Text>
        <Badge
          color={showSplashScreen ? "yellow" : serverStatus.running ? "green" : "red"}
          children={showSplashScreen ? "Setup" : serverStatus.running ? "Online" : "Offline"}
        />
        <Text>| Logs: {serverLogs.length} entries</Text>
        {!showSplashScreen && (
          <>
            <Text color="magenta">| ▨ OTEL: ON</Text>
            <Text color="cyan">| ◦ Debug: ON</Text>
            {serverOnlyLogs.filter((log: LogEntry) => log.content.includes("[PERF]")).length > 0 &&
              (
                <Text color="yellow">
                  {" "}
                  | ◆ Perf:{" "}
                  {serverOnlyLogs.filter((log: LogEntry) => log.content.includes("[PERF]")).length}
                </Text>
              )}
          </>
        )}
        {showSplashScreen && <Text color="cyan">| Type "/init" or "reload"</Text>}
      </Box>
    </FullScreenBox>
  );
};

export default TUICommand;
