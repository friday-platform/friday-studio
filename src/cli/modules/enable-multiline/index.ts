/**
 * Terminal setup module exports
 */

export * from "./types.ts";
export * from "./detector.ts";
export * from "./utils.ts";
export { restoreAppleTerminal, setupAppleTerminal } from "./apple-terminal.ts";
export { restoreITerm2, setupITerm2 } from "./iterm2.ts";
export { restoreGhostty, setupGhostty } from "./ghostty.ts";

import { getTerminalContext } from "./detector.ts";
import { setupAppleTerminal } from "./apple-terminal.ts";
import { setupITerm2 } from "./iterm2.ts";
import { setupGhostty } from "./ghostty.ts";
import { PreFlightCheckResult, SetupResult } from "./types.ts";
import { execCommand, fileExists, getHomeDir, isCI } from "./utils.ts";

/**
 * Main terminal setup function
 */
export async function setupTerminal(): Promise<SetupResult> {
  // Run pre-flight checks
  const preFlightResult = await preFlightCheck();
  if (!preFlightResult.canProceed) {
    return {
      success: false,
      error: preFlightResult.issues.join("; "),
    };
  }

  // Warnings are available but not displayed in app context mode

  // Get terminal context
  const context = await getTerminalContext();
  const { terminal, isSSH } = context;

  // Context warnings are available but not displayed in app context mode

  // Check for problematic environments
  if (isSSH && terminal.confidence === "low") {
    return {
      success: false,
      error: "Cannot reliably detect terminal over SSH. Please run this command locally.",
    };
  }

  // Handle supported terminals
  switch (terminal.type) {
    case "Apple_Terminal": {
      const result = await setupAppleTerminal();
      return { ...result, terminalType: "Apple_Terminal" };
    }

    case "iTerm.app": {
      const result = await setupITerm2();
      return { ...result, terminalType: "iTerm.app" };
    }

    case "ghostty": {
      const result = await setupGhostty();
      return { ...result, terminalType: "ghostty" };
    }

    case "unknown":
      return {
        success: false,
        error: "Could not detect terminal type",
      };

    default:
      return {
        success: false,
        error: `Terminal "${terminal.type}" is not supported`,
      };
  }
}

/**
 * Pre-flight check before running setup
 */
export async function preFlightCheck(): Promise<PreFlightCheckResult> {
  const issues: string[] = [];
  const warnings: string[] = [];

  // Check if running in CI
  if (isCI()) {
    issues.push("Cannot configure terminal in CI environment");
  }

  // Check platform - only macOS is supported
  if (Deno.build.os !== "darwin") {
    issues.push(
      `Platform "${Deno.build.os}" is not supported - only macOS (darwin) is supported`,
    );
  }

  // Check permissions for macOS preference files
  if (Deno.build.os === "darwin") {
    try {
      const prefsDir = `${getHomeDir()}/Library/Preferences`;
      await Deno.stat(prefsDir);
    } catch {
      issues.push("Cannot access macOS preferences directory");
    }
  }

  // Check for required commands (macOS only)
  if (Deno.build.os === "darwin") {
    const requiredCommands = ["defaults", "/usr/libexec/PlistBuddy", "killall"];

    for (const cmd of requiredCommands) {
      try {
        const { success } = await execCommand("which", [cmd]);
        if (!success) {
          // For PlistBuddy, check directly since it might not be in PATH
          if (cmd === "/usr/libexec/PlistBuddy") {
            if (!await fileExists(cmd)) {
              issues.push(`Required command "${cmd}" not found`);
            }
          } else {
            issues.push(`Required command "${cmd}" not found`);
          }
        }
      } catch {
        // For PlistBuddy, check directly
        if (cmd === "/usr/libexec/PlistBuddy") {
          if (!await fileExists(cmd)) {
            issues.push(`Required command "${cmd}" not found`);
          }
        } else {
          issues.push(`Cannot check for command "${cmd}"`);
        }
      }
    }
  }

  // Check terminal context for warnings
  const context = await getTerminalContext();
  if (context.isSSH) {
    warnings.push("SSH session detected - terminal configuration may not work as expected");
  }

  if (context.isTmux || context.isScreen) {
    warnings.push("Terminal multiplexer detected - will configure underlying terminal");
  }

  if (context.isDocker) {
    warnings.push("Docker container detected - changes may not persist");
  }

  return {
    canProceed: issues.length === 0,
    issues,
    warnings,
  };
}
