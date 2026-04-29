/**
 * Version display functions for Atlas CLI
 * Handles human-readable and JSON output of version information
 */

import { getVersionInfo } from "@atlas/utils";

/**
 * Format version info for display
 * Returns an array of lines to be printed
 */
function formatVersionDisplay(versionInfo: ReturnType<typeof getVersionInfo>): string[] {
  const lines: string[] = [`Atlas ${versionInfo.version}`];

  if (versionInfo.isDev) {
    lines.push(
      `Running from source${
        versionInfo.gitSha && versionInfo.gitSha !== "dev" ? ` (${versionInfo.gitSha})` : ""
      }`,
    );
  }

  if (versionInfo.isNightly) {
    lines.push(`Nightly build from commit ${versionInfo.gitSha}`);
  }

  if (versionInfo.isCompiled && !versionInfo.isNightly) {
    lines.push("Release build");
  }

  return lines;
}

/**
 * Display version information based on the json flag
 * Handles both human-readable and JSON output formats
 */
export function displayVersion(jsonOutput: boolean = false): void {
  const versionInfo = getVersionInfo();

  if (jsonOutput) {
    // JSON output to stdout
    console.log(JSON.stringify(versionInfo, null, 2));
  } else {
    // Human-readable output
    const lines = formatVersionDisplay(versionInfo);
    for (const line of lines) {
      console.log(line);
    }
  }
}
