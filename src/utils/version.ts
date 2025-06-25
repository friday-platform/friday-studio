/**
 * Version detection utility for Atlas
 * Returns different version strings based on execution context
 */

// This will be replaced during compilation by build scripts
const COMPILED_VERSION = "__ATLAS_VERSION__";
const COMPILED_GIT_SHA = "__ATLAS_GIT_SHA__";

export function getAtlasVersion(): string {
  // Check if running as compiled binary (version was replaced during build)
  // Use computed string to avoid sed replacement
  const versionPlaceholder = "__ATLAS_" + "VERSION__";

  if (COMPILED_VERSION !== versionPlaceholder) {
    // This is a compiled binary - return the full version that was embedded
    return COMPILED_VERSION;
  }

  // Check if running from source with deno task
  try {
    // Try to get git commit hash for source builds
    const decoder = new TextDecoder();
    const gitProcess = new Deno.Command("git", {
      args: ["rev-parse", "--short", "HEAD"],
      stdout: "piped",
      stderr: "piped",
    });
    const output = gitProcess.outputSync();

    if (output.success) {
      const gitSha = decoder.decode(output.stdout).trim();
      return `dev-${gitSha}`;
    }
  } catch (_error) {
    // Git not available or not in git repository
  }

  // Fallback for source builds without git
  return "dev";
}

export function getVersionInfo() {
  const version = getAtlasVersion();
  const versionPlaceholder = "__ATLAS_" + "VERSION__";
  const shaPlaceholder = "__ATLAS_" + "GIT_SHA__";
  const isCompiled = COMPILED_VERSION !== versionPlaceholder;
  const isNightly = version.startsWith("nightly-");
  const isDev = version.startsWith("dev");

  return {
    version,
    isCompiled,
    isNightly,
    isDev,
    gitSha: isDev
      ? version.replace("dev-", "")
      : isNightly
      ? version.replace("nightly-", "")
      : COMPILED_GIT_SHA !== shaPlaceholder
      ? COMPILED_GIT_SHA
      : undefined,
  };
}

/**
 * Format version info for display
 * Returns an array of lines to be printed
 */
export function formatVersionDisplay(versionInfo: ReturnType<typeof getVersionInfo>): string[] {
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
    lines.forEach((line) => console.log(line));
  }
}
