/**
 * Terminal detection logic
 */

import type { TerminalContext, TerminalInfo } from "./types.ts";
import { execCommand, fileExists, getHomeDir } from "./utils.ts";

/**
 * Detect the current terminal emulator
 */
export async function detectTerminal(): Promise<TerminalInfo> {
  // Platform check - only support macOS
  if (Deno.build.os !== "darwin") {
    return {
      type: "unknown",
      isSupported: false,
      confidence: "high",
      detectionMethod: `Platform ${Deno.build.os} is not supported - only macOS (darwin) is supported`,
    };
  }

  // Method 1: Check environment variables (most reliable)
  const termProgram = Deno.env.get("TERM_PROGRAM");

  // Direct terminal detection via TERM_PROGRAM
  if (termProgram === "Apple_Terminal") {
    return {
      type: "Apple_Terminal",
      isSupported: true,
      confidence: "high",
      detectionMethod: "TERM_PROGRAM env var",
    };
  }

  if (termProgram === "iTerm.app") {
    return {
      type: "iTerm.app",
      isSupported: true,
      confidence: "high",
      detectionMethod: "TERM_PROGRAM env var",
    };
  }

  // Method 2: Terminal-specific environment variables

  // iTerm2 detection via alternative env vars
  if (Deno.env.get("LC_TERMINAL") === "iTerm2" || Deno.env.get("ITERM_SESSION_ID")) {
    return {
      type: "iTerm.app",
      isSupported: true,
      confidence: "high",
      detectionMethod: "iTerm-specific env vars",
    };
  }

  // Ghostty detection
  if (
    Deno.env.get("GHOSTTY_RESOURCES_DIR") ||
    Deno.env.get("GHOSTTY_BIN_DIR") ||
    termProgram === "ghostty"
  ) {
    return {
      type: "ghostty",
      isSupported: true,
      confidence: "high",
      detectionMethod: "Ghostty env vars",
    };
  }

  // Method 3: Process tree inspection
  const terminal = await detectViaProcessTree();
  if (terminal) {
    return terminal;
  }

  // Method 4: Check for terminal-specific files/configs
  const ghosttyConfig = await checkGhosttyConfig();
  if (ghosttyConfig) {
    return {
      type: "ghostty",
      isSupported: true,
      confidence: "medium",
      detectionMethod: "Config file presence",
    };
  }

  // Method 5: TTY name inspection (last resort)
  const ttyTerminal = await detectViaTTY();
  if (ttyTerminal) {
    return ttyTerminal;
  }

  return {
    type: "unknown",
    isSupported: false,
    confidence: "low",
    detectionMethod: "No detection method succeeded",
  };
}

/**
 * Detect terminal via process tree inspection
 */
async function detectViaProcessTree(): Promise<TerminalInfo | null> {
  try {
    // Get parent process ID
    const ppid = Deno.ppid;
    if (!ppid) return null;

    // Use ps to get process tree
    const { stdout } = await execCommand("ps", ["-p", String(ppid), "-o", "comm="]);

    const processName = stdout.trim();

    // Check process name
    if (processName.includes("Terminal")) {
      return {
        type: "Apple_Terminal",
        isSupported: true,
        confidence: "medium",
        detectionMethod: "Process tree inspection",
      };
    }

    if (processName.includes("iTerm")) {
      return {
        type: "iTerm.app",
        isSupported: true,
        confidence: "medium",
        detectionMethod: "Process tree inspection",
      };
    }

    if (processName.includes("ghostty")) {
      return {
        type: "ghostty",
        isSupported: true,
        confidence: "medium",
        detectionMethod: "Process tree inspection",
      };
    }

    // Walk up the process tree further if needed
    const grandParent = await getParentProcess(ppid);
    if (grandParent) {
      if (grandParent.includes("Terminal")) {
        return {
          type: "Apple_Terminal",
          isSupported: true,
          confidence: "low",
          detectionMethod: "Grandparent process inspection",
        };
      }
      // Check other terminals
      if (grandParent.includes("iTerm")) {
        return {
          type: "iTerm.app",
          isSupported: true,
          confidence: "low",
          detectionMethod: "Grandparent process inspection",
        };
      }
      if (grandParent.includes("ghostty")) {
        return {
          type: "ghostty",
          isSupported: true,
          confidence: "low",
          detectionMethod: "Grandparent process inspection",
        };
      }
    }
  } catch (error) {
    // Process inspection failed, continue with other methods
    console.debug("Process tree inspection failed:", error);
  }

  return null;
}

/**
 * Get parent process name
 */
async function getParentProcess(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execCommand("ps", ["-p", String(pid), "-o", "ppid=,comm="]);

    const output = stdout.trim();
    const [, comm] = output.split(/\s+/, 2);

    return comm || null;
  } catch {
    return null;
  }
}

/**
 * Check if Ghostty config exists
 */
async function checkGhosttyConfig(): Promise<boolean> {
  // Only check on macOS
  if (Deno.build.os !== "darwin") {
    return false;
  }

  const home = getHomeDir();
  const configPaths = [
    `${home}/.config/ghostty/config`,
    `${home}/Library/Application Support/com.mitchellh.ghostty/config`,
  ];

  for (const path of configPaths) {
    if (await fileExists(path)) {
      return true;
    }
  }

  return false;
}

/**
 * Detect terminal via TTY ownership
 */
async function detectViaTTY(): Promise<TerminalInfo | null> {
  try {
    // Get TTY name
    const { stdout: ttyPath } = await execCommand("tty", []);
    const tty = ttyPath.trim();

    // Use lsof to find which process owns the TTY
    const { stdout: lsofOutput } = await execCommand("lsof", [tty]);

    // Parse lsof output to find terminal
    if (lsofOutput.includes("Terminal")) {
      return {
        type: "Apple_Terminal",
        isSupported: true,
        confidence: "low",
        detectionMethod: "TTY ownership detection",
      };
    }

    if (lsofOutput.includes("iTerm")) {
      return {
        type: "iTerm.app",
        isSupported: true,
        confidence: "low",
        detectionMethod: "TTY ownership detection",
      };
    }

    if (lsofOutput.includes("ghostty")) {
      return {
        type: "ghostty",
        isSupported: true,
        confidence: "low",
        detectionMethod: "TTY ownership detection",
      };
    }
  } catch {
    // TTY detection failed
  }

  return null;
}

/**
 * Check if running in SSH session
 */
export function isSSHSession(): boolean {
  return !!(Deno.env.get("SSH_CLIENT") || Deno.env.get("SSH_TTY"));
}

/**
 * Check if running in tmux session
 */
export function isTmuxSession(): boolean {
  return !!Deno.env.get("TMUX");
}

/**
 * Check if running in screen session
 */
export function isScreenSession(): boolean {
  return !!Deno.env.get("STY");
}

/**
 * Check if running in Docker container
 */
function isDockerContainer(): boolean {
  try {
    // Check for .dockerenv file
    Deno.statSync("/.dockerenv");
    return true;
  } catch {
    // Check cgroup for docker
    try {
      const cgroup = Deno.readTextFileSync("/proc/self/cgroup");
      return cgroup.includes("docker");
    } catch {
      return false;
    }
  }
}

/**
 * Get comprehensive terminal context
 */
export async function getTerminalContext(): Promise<TerminalContext> {
  const terminal = await detectTerminal();
  const isSSH = isSSHSession();
  const isTmux = isTmuxSession();
  const isScreen = isScreenSession();
  const isDocker = isDockerContainer();

  const warnings: string[] = [];

  if (isSSH) {
    warnings.push("SSH session detected - terminal detection may be unreliable");
  }

  if (isTmux) {
    warnings.push("tmux session detected - actual terminal may be masked");
  }

  if (isScreen) {
    warnings.push("screen session detected - actual terminal may be masked");
  }

  if (isDocker) {
    warnings.push("Docker container detected - terminal setup may not persist");
  }

  return { terminal, isSSH, isTmux, isScreen, isDocker, warnings };
}
