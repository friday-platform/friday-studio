/**
 * Version detection utility for Atlas
 * Returns different version strings based on execution context
 */

// This will be replaced during compilation by build scripts
const COMPILED_VERSION = "__ATLAS_VERSION__";
const COMPILED_GIT_SHA = "__ATLAS_GIT_SHA__";

// Keep original placeholders for comparison (these won't be replaced)
const VERSION_PLACEHOLDER = "__ATLAS_VERSION__";
const SHA_PLACEHOLDER = "__ATLAS_GIT_SHA__";

export function getAtlasVersion(): string {
  // Check if running as compiled binary (version was replaced during build)
  if (COMPILED_VERSION !== VERSION_PLACEHOLDER) {
    // This is a compiled binary
    if (COMPILED_VERSION.startsWith("nightly-")) {
      // Nightly build - show nightly-<git-sha>
      const gitSha = COMPILED_GIT_SHA !== SHA_PLACEHOLDER ? COMPILED_GIT_SHA : "unknown";
      return `nightly-${gitSha}`;
    } else {
      // Regular release - show release version
      return COMPILED_VERSION;
    }
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
  } catch (error) {
    // Git not available or not in git repository
  }

  // Fallback for source builds without git
  return "dev";
}

export function getVersionInfo() {
  const version = getAtlasVersion();
  const isCompiled = COMPILED_VERSION !== VERSION_PLACEHOLDER;
  const isNightly = version.startsWith("nightly-");
  const isDev = version.startsWith("dev");
  
  return {
    version,
    isCompiled,
    isNightly,
    isDev,
    gitSha: isDev ? version.replace("dev-", "") : 
           isNightly ? version.replace("nightly-", "") : 
           COMPILED_GIT_SHA !== SHA_PLACEHOLDER ? COMPILED_GIT_SHA : undefined,
  };
}