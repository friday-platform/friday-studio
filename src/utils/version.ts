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
  } catch {
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
    lines.forEach((line) => console.log(line));
  }
}

/**
 * Display version information including remote version check results
 */
export async function displayVersionWithRemote(jsonOutput: boolean = false): Promise<void> {
  const versionInfo = getVersionInfo();

  if (jsonOutput) {
    if (versionInfo.isDev) {
      // For dev builds, don't check remote and indicate why
      const result = {
        ...versionInfo,
        remote: {
          hasUpdate: false,
          skipped: true,
          reason: "Remote version checking is disabled for development builds",
        },
      };
      console.log(JSON.stringify(result, null, 2));
    } else {
      // For compiled builds, check remote (force fresh check)
      const { checkForUpdates } = await import("./version-checker.ts");
      const updateCheck = await checkForUpdates(true); // Force check, skip cache

      const result = {
        ...versionInfo,
        remote: {
          hasUpdate: updateCheck.hasUpdate,
          latestVersion: updateCheck.latestVersion,
          errorMessage: updateCheck.errorMessage,
          fromCache: updateCheck.fromCache,
        },
      };
      console.log(JSON.stringify(result, null, 2));
    }
  } else {
    // Human-readable output - show local version first
    const lines = formatVersionDisplay(versionInfo);
    lines.forEach((line) => console.log(line));

    console.log(); // Empty line

    if (versionInfo.isDev) {
      // For dev builds, show explanation instead of checking
      console.log("ℹ️  Remote version checking is disabled for development builds");
      console.log("   Development builds are always considered up-to-date");
    } else {
      // For compiled builds, check remote (force fresh check)
      console.log("Checking for updates...");

      const { checkForUpdates } = await import("./version-checker.ts");
      const updateCheck = await checkForUpdates(true); // Force check, skip cache

      if (updateCheck.errorMessage) {
        console.log(`❌ Error checking for updates: ${updateCheck.errorMessage}`);
      } else if (updateCheck.hasUpdate && updateCheck.latestVersion) {
        console.log(`🆕 A newer version is available: ${updateCheck.latestVersion}`);
        console.log(`📥 Current version: ${updateCheck.currentVersion}`);
      } else {
        console.log(`✅ You are running the latest version (${updateCheck.currentVersion})`);
      }

      if (updateCheck.fromCache) {
        console.log("ℹ️  (cached result)");
      }
    }
  }
}
